export type CliCommand =
  | { kind: "stdio" }
  | { kind: "http"; host: string; port: number }
  | { kind: "init"; target: "cursor" | "claude" | "opencode" | "all" }
  | { kind: "hook"; name: "recall" | "capture"; format: "cursor" | "claude" }
  | { kind: "help" };

const HOOKS = new Set(["recall", "capture"]);
const FORMATS = new Set(["cursor", "claude"]);
const INIT_TARGETS = new Set(["cursor", "claude", "opencode", "all"]);

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return undefined;
  return args[index + 1];
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

export function parseArgs(argv: string[]): CliCommand {
  const args = argv.filter((value) => value !== "--");
  if (args.length === 0) return { kind: "stdio" };
  if (has(args, "--help") || args[0] === "help") return { kind: "help" };

  if (args[0] === "hook") {
    const name = args[1];
    if (!HOOKS.has(name)) {
      throw new Error("Usage: brainfeather-mcp hook <recall|capture> [--format cursor|claude]");
    }
    const format = flag(args, "--format") ?? "cursor";
    if (!FORMATS.has(format)) {
      throw new Error("Hook --format must be cursor or claude.");
    }
    return { kind: "hook", name: name as "recall" | "capture", format: format as "cursor" | "claude" };
  }

  if (args[0] === "init") {
    const target = args[1] ?? "all";
    if (!INIT_TARGETS.has(target)) {
      throw new Error("Usage: brainfeather-mcp init [cursor|claude|opencode|all]");
    }
    return {
      kind: "init",
      target: target as "cursor" | "claude" | "opencode" | "all",
    };
  }

  if (has(args, "--http") || args[0] === "http") {
    const host = flag(args, "--host") ?? "127.0.0.1";
    const port = Number(flag(args, "--port") ?? "8787");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("--port must be an integer from 1 to 65535.");
    }
    return { kind: "http", host, port };
  }

  throw new Error(
    "Usage: brainfeather-mcp [--http] [--port 8787] | init [cursor|claude|opencode] | hook <recall|capture>",
  );
}
