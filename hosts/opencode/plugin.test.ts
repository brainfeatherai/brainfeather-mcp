import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import BrainfeatherPlugin from "./plugin.mjs";

const temporaryPaths: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("OpenCode plugin", () => {
  it("derives repository scope and sends it to recall and capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "brainfeather-opencode-"));
    temporaryPaths.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], {
      cwd: root,
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ facts: [], decisions: [], patterns: [], counts: { total: 0 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      config: {
        get: vi.fn().mockResolvedValue({
          data: {
            mcp: {
              brainfeather: {
                environment: { BRAINFEATHER_API_KEY: "bf_test_1234567890abcdef" },
              },
            },
          },
        }),
      },
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "This project uses Vitest for unit tests." }],
            },
          ],
        }),
      },
    };
    const previous = process.env.BRAINFEATHER_API_KEY;
    process.env.BRAINFEATHER_API_KEY = "bf_test_1234567890abcdef";
    try {
      const hooks = await BrainfeatherPlugin({ directory: root, client });
      await hooks["experimental.chat.system.transform"]({}, { system: ["base"] });
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-1" },
        },
      });
    } finally {
      if (previous === undefined) delete process.env.BRAINFEATHER_API_KEY;
      else process.env.BRAINFEATHER_API_KEY = previous;
    }

    const recall = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(recall.searchParams.get("projectId")).toBe("github.com/acme/app");
    const capture = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(capture).toMatchObject({ projectId: "github.com/acme/app", source: "opencode" });
    expect(client.session.messages).toHaveBeenCalledWith({ path: { id: "session-1" } });
  });

  it("keeps non-default Git ports in project identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "brainfeather-opencode-"));
    temporaryPaths.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      ["remote", "add", "origin", "ssh://git@git.example:2222/team/app.git"],
      { cwd: root },
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ facts: [], decisions: [], patterns: [], counts: { total: 0 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      config: {
        get: vi.fn().mockResolvedValue({
          data: { mcp: { brainfeather: { environment: { BRAINFEATHER_API_KEY: "bf_test_1234567890abcdef" } } } },
        }),
      },
    };
    const hooks = await BrainfeatherPlugin({ directory: root, client });
    await hooks["experimental.chat.system.transform"]({}, { system: ["base"] });
    const recall = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(recall.searchParams.get("projectId")).toBe("git.example:2222/team/app");
  });
});
