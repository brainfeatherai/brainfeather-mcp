/* ────────────────────────────────────────────────────────────────
   Configuration.

   Two environment variables, both matching the documented install:

     BRAINFEATHER_API_KEY   bf_live_… from brainfeather.com/settings
     BRAINFEATHER_API_URL   optional; defaults to the hosted API

   Deliberately NO database credentials. An earlier design shipped an
   Appwrite admin key here — full scope, able to read and delete every
   user's data — which made the package unpublishable: `npx` would have
   handed master access to whoever ran it. The API key is scoped to one
   account and revocable from the dashboard, so a leak is contained and
   fixable without a release.
   ──────────────────────────────────────────────────────────────── */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  apiKey: string;
  apiUrl: string;
};

const DEFAULT_API_URL = "https://brainfeather.com/api/v1";
const KEY_PATTERN = /^bf_(live|test)_[A-Za-z0-9]{16,}$/;

/* An optional config file, for people who would rather not put a key in
   their editor's settings JSON. Env always wins. */
function fromFile(): Record<string, unknown> {
  try {
    return JSON.parse(
      readFileSync(join(homedir(), ".brainfeather", "config.json"), "utf8"),
    ) as Record<string, unknown>;
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
        '    "args": ["-y", "@brainfeather/mcp"],\n' +
        '    "env": { "BRAINFEATHER_API_KEY": "bf_live_…" }\n' +
        "  }\n\n" +
        "Generate a key at https://brainfeather.com/settings",
    );
  }

  /* Checked here rather than on first request: a typo surfaces at startup
     with a readable message instead of a 401 mid-conversation, which an
     agent tends to report as "the memory tool is broken". */
  if (!KEY_PATTERN.test(apiKey)) {
    exit(
      "BRAINFEATHER_API_KEY is not a valid key.",
      `Expected bf_live_… or bf_test_…, got "${redact(apiKey)}".\n` +
        "Copy it again from https://brainfeather.com/settings",
    );
  }

  const apiUrl = (
    str(process.env.BRAINFEATHER_API_URL) ?? str(file.apiUrl) ?? DEFAULT_API_URL
  ).replace(/\/+$/, "");

  if (!/^https?:\/\//.test(apiUrl)) {
    exit(
      "BRAINFEATHER_API_URL must start with http:// or https://",
      `Got "${apiUrl}".`,
    );
  }

  return { apiKey, apiUrl };
}

/** Show enough of a key to identify it, never enough to use it. */
function redact(key: string): string {
  return key.length <= 12 ? `${key.slice(0, 4)}…` : `${key.slice(0, 11)}…${key.slice(-2)}`;
}

function exit(headline: string, detail: string): never {
  console.error(`\n[brainfeather] ${headline}\n\n${detail}\n`);
  process.exit(1);
}
