import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceError,
  hashFileEvidence,
  MAX_EVIDENCE_FILE_BYTES,
  verifyEvidence,
} from "./evidence.js";

const temporaryPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("file evidence", () => {
  it("hashes and verifies a workspace-relative regular file", () => {
    const root = temporaryDirectory("brainfeather-evidence-");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "architecture.md"), "Use Postgres.\n");
    const digest = hashFileEvidence(root, "docs/architecture.md");

    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      verifyEvidence(root, {
        type: "file",
        reference: "docs/architecture.md",
        digest,
      }),
    ).toEqual({
      status: "verified",
      type: "file",
      reference: "docs/architecture.md",
    });
  });

  it("detects changed and missing files", () => {
    const root = temporaryDirectory("brainfeather-evidence-");
    const path = join(root, "decision.txt");
    writeFileSync(path, "first");
    const digest = hashFileEvidence(root, "decision.txt");
    writeFileSync(path, "second");
    const evidence = { type: "file" as const, reference: "decision.txt", digest };

    expect(verifyEvidence(root, evidence).status).toBe("changed");
    rmSync(path);
    expect(verifyEvidence(root, evidence).status).toBe("missing");
  });

  it("blocks traversal and symlinks outside the workspace", () => {
    const parent = temporaryDirectory("brainfeather-evidence-");
    const root = join(parent, "workspace");
    mkdirSync(root);
    writeFileSync(join(parent, "outside.txt"), "outside");
    symlinkSync(join(parent, "outside.txt"), join(root, "outside-link"));

    expect(() => hashFileEvidence(root, "../outside.txt")).toThrow(EvidenceError);
    expect(() => hashFileEvidence(root, "outside-link")).toThrow(EvidenceError);
    expect(
      verifyEvidence(root, {
        type: "file",
        reference: "outside-link",
        digest: `sha256:${"0".repeat(64)}`,
      }).status,
    ).toBe("unverifiable");
  });

  it("refuses oversized files and evidence without a stored digest", () => {
    const root = temporaryDirectory("brainfeather-evidence-");
    writeFileSync(join(root, "large.bin"), Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1));
    writeFileSync(join(root, "plain.txt"), "content");

    expect(() => hashFileEvidence(root, "large.bin")).toThrow(EvidenceError);
    expect(
      verifyEvidence(root, {
        type: "file",
        reference: "large.bin",
        digest: `sha256:${"0".repeat(64)}`,
      }).status,
    ).toBe("unverifiable");
    expect(
      verifyEvidence(root, { type: "file", reference: "plain.txt" }).status,
    ).toBe("unverifiable");
  });
});

describe("commit evidence", () => {
  it("verifies existing commits and marks unknown commits missing", () => {
    const root = temporaryDirectory("brainfeather-git-evidence-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Brainfeather Test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    expect(verifyEvidence(root, { type: "commit", reference: commit }).status).toBe(
      "verified",
    );
    expect(
      verifyEvidence(root, { type: "commit", reference: "0".repeat(40) }).status,
    ).toBe("missing");
    expect(verifyEvidence(root, { type: "commit", reference: "--help" }).status).toBe(
      "missing",
    );
  });

  it("does not claim commit verification outside a Git worktree", () => {
    const root = temporaryDirectory("brainfeather-no-git-");
    expect(verifyEvidence(root, { type: "commit", reference: "HEAD" }).status).toBe(
      "unverifiable",
    );
  });
});
