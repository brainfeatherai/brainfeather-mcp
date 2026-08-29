import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { detectProject } from "./project.js";
import { contextBlock } from "./format.js";
import { loadConfig, type Config } from "./config.js";
import { Client } from "./client.js";

export type HookFormat = "cursor" | "claude";
export type HookName = "recall" | "capture";

type HookInput = {
  prompt?: string;
  text?: string;
  conversation?: string;
  transcript?: string;
  workspace_roots?: string[];
  cwd?: string;
  hook_event_name?: string;
};

const MIN_PROMPT = 12;
const HOOK_TIMEOUT_MS = 6_000;

function readJson(raw: string): HookInput {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

function workspacePath(input: HookInput): string {
  const root = input.workspace_roots?.[0];
  if (typeof root === "string") {
    if (root.startsWith("file:")) {
      try {
        return fileURLToPath(root);
      } catch {
        /* fall through */
      }
    }
    if (root.startsWith("/")) return root;
  }
  if (typeof input.cwd === "string" && input.cwd.startsWith("/")) return input.cwd;
  return process.cwd();
}

function promptOf(input: HookInput): string {
  const value = input.prompt ?? input.text ?? "";
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

function activityOf(input: HookInput): string {
  const value = input.text ?? input.conversation ?? input.transcript ?? input.prompt ?? "";
  return value.replace(/\s+/g, " ").trim().slice(0, 8000);
}

function recallPayload(format: HookFormat, body: string, eventName: string) {
  if (format === "claude") {
    const sessionStart =
      eventName.includes("sessionstart") || eventName.includes("session_start");
    return {
      hookSpecificOutput: {
        hookEventName: sessionStart ? "SessionStart" : "UserPromptSubmit",
        additionalContext: body,
      },
    };
  }
  return { additional_context: body };
}

function emptyPayload(format: HookFormat) {
  return format === "claude" ? {} : {};
}

export async function runHook(
  name: HookName,
  format: HookFormat,
  stdin: string,
  options: { config?: Config; client?: Client; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  try {
    const input = readJson(stdin);
    const config = options.config ?? loadConfig();
    const client = options.client ?? new Client(config);
    const path = workspacePath(input);
    const projectId = config.projectId ?? detectProject(path) ?? undefined;

    if (name === "recall") {
      const query = promptOf(input);
      const event = (input.hook_event_name ?? "").toLowerCase();
      const sessionStart = event.includes("sessionstart") || event.includes("session_start");
      if (query.length < MIN_PROMPT && !sessionStart) {
        return JSON.stringify(emptyPayload(format));
      }
      const ctx = await client.getContext(
        projectId,
        Boolean(projectId),
        AbortSignal.timeout(HOOK_TIMEOUT_MS),
        query.length >= MIN_PROMPT ? { query, maxTokens: 1200 } : { maxTokens: 1200 },
      );
      if (!ctx.counts.total) return JSON.stringify(emptyPayload(format));
      return JSON.stringify(recallPayload(format, contextBlock(ctx), event));
    }

    const activity = activityOf(input);
    if (activity.length < 24) return JSON.stringify(emptyPayload(format));
    await client.captureActivity(
      {
        activity,
        projectId,
        source: format === "claude" ? "claude" : "cursor",
      },
      AbortSignal.timeout(HOOK_TIMEOUT_MS),
    );
    return JSON.stringify(emptyPayload(format));
  } catch {
    return JSON.stringify(emptyPayload(format));
  }
}

export function hookHome(): string {
  return homedir();
}
