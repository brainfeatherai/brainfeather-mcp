import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectProject,
  normalizeRemote,
  ProjectResolver,
  ProjectScopeError,
  type RootsClient,
} from "./project.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function rootsClient(
  roots?: string[],
  options: { listChanged?: boolean; uris?: string[] } = {},
): RootsClient {
  return {
    getClientCapabilities: () =>
      roots ? { roots: { listChanged: options.listChanged ?? true } } : undefined,
    listRoots: async () => ({
      roots:
        options.uris?.map((uri) => ({ uri })) ??
        (roots ?? []).map((path) => ({ uri: pathToFileURL(path).href })),
    }),
  };
}

describe("normalizeRemote", () => {
  it.each([
    "https://github.com/acme/app.git",
    "git@github.com:acme/app.git",
    "ssh://git@github.com:22/acme/app.git/",
    "https://token:secret@github.com/acme/app.git?ref=main",
  ])("normalizes %s", (remote) => {
    expect(normalizeRemote(remote)).toBe("github.com/acme/app");
  });

  it("rejects local file remotes", () => {
    expect(normalizeRemote("file:///tmp/repository.git")).toBeNull();
  });

  it("preserves case-sensitive repository paths", () => {
    expect(normalizeRemote("https://GitLab.example/Team/Product.git")).toBe(
      "gitlab.example/Team/Product",
    );
  });

  it("keeps non-default Git server ports in the identity", () => {
    expect(normalizeRemote("ssh://git@git.example:2222/team/app.git")).toBe(
      "git.example:2222/team/app",
    );
  });
});

describe("detectProject", () => {
  it("does not collide for unrelated local folders with the same basename", () => {
    const first = mkdtempSync(join(tmpdir(), "brainfeather-first-"));
    const second = mkdtempSync(join(tmpdir(), "brainfeather-second-"));
    temporaryPaths.push(first, second);
    mkdirSync(join(first, "app"));
    mkdirSync(join(second, "app"));

    const firstId = detectProject(join(first, "app"));
    const secondId = detectProject(join(second, "app"));

    expect(firstId).toMatch(/^local\/app~/);
    expect(secondId).toMatch(/^local\/app~/);
    expect(firstId).not.toBe(secondId);
  });
});

describe("ProjectResolver", () => {
  it("uses the single MCP filesystem root", async () => {
    const resolver = new ProjectResolver(rootsClient([process.cwd()]));
    await expect(resolver.resolve()).resolves.toBe(detectProject(process.cwd()));
  });

  it("fails closed for multiple roots", async () => {
    const resolver = new ProjectResolver(rootsClient([process.cwd(), resolve("..")]), undefined);
    await expect(resolver.resolve()).rejects.toBeInstanceOf(ProjectScopeError);
  });

  it("lets an explicit project id resolve ambiguous workspaces", async () => {
    const resolver = new ProjectResolver(rootsClient([]), "team/product-api");
    await expect(resolver.resolve()).resolves.toBe("team/product-api");
  });

  it("fails closed when the client does not expose Roots", async () => {
    const resolver = new ProjectResolver(rootsClient());
    await expect(resolver.resolve()).rejects.toBeInstanceOf(ProjectScopeError);
  });

  it("rejects mixed filesystem and virtual roots", async () => {
    const resolver = new ProjectResolver(
      rootsClient([], {
        uris: [pathToFileURL(process.cwd()).href, "vscode-vfs://workspace/remote"],
      }),
    );
    await expect(resolver.resolve()).rejects.toBeInstanceOf(ProjectScopeError);
  });

  it("re-reads roots when list changes are unsupported", async () => {
    let calls = 0;
    const client: RootsClient = {
      getClientCapabilities: () => ({ roots: { listChanged: false } }),
      listRoots: async () => {
        calls++;
        return { roots: [{ uri: pathToFileURL(process.cwd()).href }] };
      },
    };
    const resolver = new ProjectResolver(client);
    await resolver.resolve();
    await resolver.resolve();
    expect(calls).toBe(2);
  });
});
