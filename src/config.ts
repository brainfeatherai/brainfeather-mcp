/* ────────────────────────────────────────────────────────────────
   Configuration.

   Two environment variables, both matching the documented install:

     BRAINFEATHER_API_KEY   bf_live_… from brainfeather.com/api-keys
     BRAINFEATHER_API_URL   optional; defaults to the hosted API

   Deliberately NO database credentials. An earlier design shipped an
   Appwrite admin key here — full scope, able to read and delete every
   user's data — which made the package unpublishable: `npx` would have
   handed master access to whoever ran it. The API key is scoped to one
   account and revocable from the dashboard, so a leak is contained and
   fixable without a release.
   ──────────────────────────────────────────────────────────────── */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  apiKey: string;
  apiUrl: string;
  projectId?: string;
};

const DEFAULT_API_URL = "https://brainfeather.com/api/v1";
const KEY_PATTERN = /^bf_(?:(?:live|test)_[A-Za-z0-9]{16,128}|[A-Fa-f0-9]{16,128})$/;

export function isValidApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/* An optional config file, for people who would rather not put a key in
   their editor's settings JSON. Env always wins. */
const CONFIG_PATH = join(homedir(), ".brainfeather", "config.json");

function fromFile(): Record<string, unknown> {
  try {
    const mode = statSync(CONFIG_PATH).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(
        `[brainfeather] WARNING: ${CONFIG_PATH} is readable by other users. Run: chmod 600 ${CONFIG_PATH}`,
      );
    }
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export function loadConfig(): Config {
  const file = fromFile();

  /* A stale admin key in that file is a live exposure, not a leftover:
     it is plaintext, readable by anything running as this user, and it
     still works until revoked. Warn on stderr, which MCP clients log
     without corrupting the stdio JSON-RPC stream on stdout. */
  if (file.appwriteKey) {
    console.error(
      "[brainfeather] WARNING: ~/.brainfeather/config.json contains `appwriteKey`. " +
        "It is unused now. Delete the field and revoke that key in the Appwrite " +
        "console — it grants full database access.",
    );
  }

  /* BRAINFEATHER_TOKEN is the old name, still accepted so an existing
     install does not break on upgrade. */
  const apiKey =
    str(process.env.BRAINFEATHER_API_KEY) ??
    str(process.env.BRAINFEATHER_TOKEN) ??
    str(file.apiKey) ??
    str(file.token);

  if (!apiKey) {
    exit(
      "Missing BRAINFEATHER_API_KEY.",
      'Add it to your MCP client config:\n\n' +
        '  "brainfeather": {\n' +
        '    "command": "npx",\n' +
        '    "args": ["-y", "@brainfeather/mcp@1.5.0"],\n' +
        '    "env": { "BRAINFEATHER_API_KEY": "bf_live_…" }\n' +
        "  }\n\n" +
        "Generate a key at https://brainfeather.com/api-keys",
    );
  }

  /* Checked here rather than on first request: a typo surfaces at startup
     with a readable message instead of a 401 mid-conversation, which an
     agent tends to report as "the memory tool is broken". */
  if (!isValidApiKey(apiKey)) {
    exit(
      "BRAINFEATHER_API_KEY is not a valid key.",
      `Expected bf_live_…, bf_test_…, or a legacy bf_ key; received ${apiKey.length} characters.\n` +
        "Copy it again from https://brainfeather.com/api-keys",
    );
  }

  const rawApiUrl = (
    str(process.env.BRAINFEATHER_API_URL) ?? str(file.apiUrl) ?? DEFAULT_API_URL
  ).replace(/\/+$/, "");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawApiUrl);
  } catch {
    exit(
      "BRAINFEATHER_API_URL must be a valid URL.",
      `Got "${rawApiUrl}".`,
    );
  }

  if (parsedUrl.username || parsedUrl.password) {
    exit("BRAINFEATHER_API_URL must not contain credentials.", "Use BRAINFEATHER_API_KEY instead.");
  }

  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    parsedUrl.hostname,
  );
  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && local)) {
    exit(
      "BRAINFEATHER_API_URL must use HTTPS.",
      "Plain HTTP is accepted only for localhost because it exposes the API key in transit.",
    );
  }

  const projectId =
    str(process.env.BRAINFEATHER_PROJECT_ID) ?? str(file.projectId);
  if (projectId && (projectId.length > 64 || /[\u0000-\u001f\u007f]/.test(projectId))) {
    exit(
      "BRAINFEATHER_PROJECT_ID is invalid.",
      "Use 1-64 printable characters.",
    );
  }

  return { apiKey, apiUrl: parsedUrl.href.replace(/\/+$/, ""), projectId };
}

function exit(headline: string, detail: string): never {
  console.error(`\n[brainfeather] ${headline}\n\n${detail}\n`);
  process.exit(1);
}
