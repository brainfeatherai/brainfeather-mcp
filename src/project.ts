import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ID = 64;
const HASH_LEN = 10;

export class ProjectScopeError extends Error {}

export type RootsClient = {
  getClientCapabilities(): { roots?: { listChanged?: boolean } } | undefined;
  listRoots(
    params?: Record<string, never>,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ roots: { uri: string; name?: string }[] }>;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_LEN);
}

export function fitProjectId(id: string): string {
  if (id.length <= MAX_ID) return id;
  return `${id.slice(0, MAX_ID - HASH_LEN - 1)}~${digest(id)}`;
}

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
}

/** Normalize common Git transports to one stable host/owner/repository id. */
export function normalizeRemote(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;

  try {
    const parsed = new URL(input);
    if (parsed.protocol === "file:") return null;

    const defaultPort =
      (parsed.protocol === "ssh:" && parsed.port === "22") ||
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80");
    const host = `${parsed.hostname.toLowerCase()}${parsed.port && !defaultPort ? `:${parsed.port}` : ""}`;
    const path = stripGitSuffix(parsed.pathname).replace(/^\/+/, "");
    if (!host || !path) return null;
    return fitProjectId(`${host}/${path}`);
  } catch {
    /* SCP-style remotes are not valid URLs: git@host:owner/repo.git. */
    const withoutQuery = input.split(/[?#]/, 1)[0];
    const match = withoutQuery.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
    if (!match) return null;

    const host = match[1].toLowerCase();
    const path = stripGitSuffix(match[2]).replace(/^\/+/, "");
    if (!host || !path) return null;
    return fitProjectId(`${host}/${path}`);
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Resolve one workspace path to a stable project id without reading its files. */
export function detectProject(workspacePath = process.cwd()): string | null {
  const cwd = resolve(workspacePath);
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  if (remote) {
    const normalized = normalizeRemote(remote);
    if (normalized) return normalized;
  }

  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const identityPath = root ? resolve(root) : cwd;
  if (identityPath === homedir() || identityPath === "/") return null;

  const name = basename(identityPath).toLowerCase();
  if (!name || name === "." || name === "tmp") return null;

  /* The path hash prevents two unrelated local folders named `app` from
     sharing memory while keeping the id recognizable in the dashboard. */
  return fitProjectId(`local/${name}~${digest(identityPath)}`);
}

function rootPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:" ? fileURLToPath(parsed) : null;
  } catch {
    return null;
  }
}

export class ProjectResolver {
  private cached: string | undefined;
  private resolvedProjectId: string | undefined;
  private resolvedRoot: string | undefined;
  private generation = 0;

  constructor(
    private readonly rootsClient: RootsClient,
    private readonly configuredProjectId?: string,
  ) {}

  invalidate(): void {
    this.generation++;
    this.cached = undefined;
    this.resolvedProjectId = undefined;
    this.resolvedRoot = undefined;
  }

  async resolve(signal?: AbortSignal): Promise<string> {
    if (this.configuredProjectId) return this.configuredProjectId;
    if (this.cached) return this.cached;

    const capabilities = this.rootsClient.getClientCapabilities();
    if (capabilities?.roots) {
      const generation = this.generation;
      let roots: { uri: string; name?: string }[];
      try {
        ({ roots } = await this.rootsClient.listRoots({}, { signal, timeout: 5000 }));
      } catch {
        throw new ProjectScopeError(
          "Brainfeather could not read the MCP workspace roots. Retry, or set BRAINFEATHER_PROJECT_ID explicitly.",
        );
      }

      if (roots.length !== 1) {
        throw new ProjectScopeError(
          roots.length === 0
            ? "Brainfeather needs one filesystem workspace root. Open a project or set BRAINFEATHER_PROJECT_ID."
            : "Brainfeather cannot choose safely between multiple workspace roots. Set BRAINFEATHER_PROJECT_ID for this MCP server.",
        );
      }

      const path = rootPath(roots[0].uri);
      if (!path) {
        throw new ProjectScopeError(
          "Brainfeather requires one local filesystem workspace root. Set BRAINFEATHER_PROJECT_ID for virtual or remote workspaces.",
        );
      }

      const projectId = detectProject(path);
      if (!projectId) {
        throw new ProjectScopeError(
          "Brainfeather could not identify this workspace safely. Set BRAINFEATHER_PROJECT_ID in the MCP configuration.",
        );
      }
      if (generation !== this.generation) return this.resolve(signal);
      this.resolvedProjectId = projectId;
      this.resolvedRoot = realpathSync(path);
      if (capabilities.roots.listChanged) this.cached = projectId;
      return projectId;
    }

    throw new ProjectScopeError(
      "This MCP client does not expose workspace roots. Set BRAINFEATHER_PROJECT_ID in the MCP configuration.",
    );
  }

  async workspaceRoot(projectId: string, signal?: AbortSignal): Promise<string | null> {
    const capabilities = this.rootsClient.getClientCapabilities();
    if (!capabilities?.roots) return null;
    try {
      const { roots } = await this.rootsClient.listRoots({}, { signal, timeout: 5000 });
      if (roots.length !== 1) return null;
      const path = rootPath(roots[0].uri);
      if (!path) return null;
      const root = realpathSync(path);
      if (
        !this.configuredProjectId &&
        (this.resolvedProjectId !== projectId || this.resolvedRoot !== root)
      ) {
        return null;
      }
      return root;
    } catch {
      return null;
    }
  }
}
