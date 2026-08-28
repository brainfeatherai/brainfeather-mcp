import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;

export type Evidence = {
  type: "user" | "agent" | "commit" | "pull_request" | "issue" | "file" | "deployment";
  reference?: string;
  digest?: string;
};

export type VerificationStatus = "verified" | "changed" | "missing" | "unverifiable";

export type EvidenceVerification = {
  status: VerificationStatus;
  type?: Evidence["type"];
  reference?: string;
};

export class EvidenceError extends Error {}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function safeFilePath(workspaceRoot: string, reference: string): string {
  if (!reference || isAbsolute(reference)) {
    throw new EvidenceError("File evidence must use a workspace-relative path.");
  }
  const root = realpathSync(workspaceRoot);
  const candidate = resolve(root, reference);
  if (!inside(root, candidate)) {
    throw new EvidenceError("File evidence cannot escape the workspace root.");
  }

  let target: string;
  try {
    target = realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EvidenceError("File evidence does not exist.");
    }
    throw new EvidenceError("File evidence cannot be read safely.");
  }
  if (!inside(root, target)) {
    throw new EvidenceError("File evidence cannot follow a symlink outside the workspace.");
  }
  return target;
}

function fileDigest(workspaceRoot: string, reference: string): string {
  const target = safeFilePath(workspaceRoot, reference);
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EvidenceError("File evidence does not exist.");
    }
    throw new EvidenceError("File evidence cannot be read safely.");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new EvidenceError("File evidence must reference a regular file.");
    if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
      throw new EvidenceError(
        `File evidence exceeds the ${MAX_EVIDENCE_FILE_BYTES}-byte verification limit.`,
      );
    }
    const hash = createHash("sha256");
    const content = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const length = readSync(fd, content, 0, content.length, null);
      if (length === 0) break;
      total += length;
      if (total > MAX_EVIDENCE_FILE_BYTES) {
        throw new EvidenceError(
          `File evidence exceeds the ${MAX_EVIDENCE_FILE_BYTES}-byte verification limit.`,
        );
      }
      hash.update(content.subarray(0, length));
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    closeSync(fd);
  }
}

export function hashFileEvidence(workspaceRoot: string, reference: string): string {
  return fileDigest(workspaceRoot, reference);
}

function git(workspaceRoot: string, args: string[]): boolean {
  try {
    execFileSync("git", args, {
      cwd: workspaceRoot,
      stdio: "ignore",
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

export function verifyEvidence(
  workspaceRoot: string | null,
  evidence: Evidence | null | undefined,
): EvidenceVerification {
  const base = evidence
    ? {
        type: evidence.type,
        ...(evidence.reference ? { reference: evidence.reference } : {}),
      }
    : {};
  if (!workspaceRoot || !evidence) return { status: "unverifiable", ...base };

  if (evidence.type === "file") {
    if (!evidence.reference || !evidence.digest) {
      return { status: "unverifiable", ...base };
    }
    try {
      const digest = fileDigest(workspaceRoot, evidence.reference);
      return {
        status: digest === evidence.digest ? "verified" : "changed",
        ...base,
      };
    } catch (error) {
      if (error instanceof EvidenceError && error.message === "File evidence does not exist.") {
        return { status: "missing", ...base };
      }
      return { status: "unverifiable", ...base };
    }
  }

  if (evidence.type === "commit") {
    if (!evidence.reference) return { status: "unverifiable", ...base };
    if (!git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"])) {
      return { status: "unverifiable", ...base };
    }
    return {
      status: git(workspaceRoot, ["cat-file", "-e", "--", `${evidence.reference}^{commit}`])
        ? "verified"
        : "missing",
      ...base,
    };
  }

  return { status: "unverifiable", ...base };
}
