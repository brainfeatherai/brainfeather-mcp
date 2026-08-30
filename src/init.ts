import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function readTemplate(relative: string): string {
  return readFileSync(join(packageRoot(), relative), "utf8");
}

function writeFile(path: string, contents: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (mode) chmodSync(path, mode);
}

function mergeCursorHooks(existing: unknown, recall: string, capture: string): string {
  const current =
    existing && typeof existing === "object" ? (existing as { hooks?: Record<string, unknown[]> }) : {};
  const hooks = { ...(current.hooks ?? {}) };
  const withoutBrainfeather = (entries: unknown[] | undefined) =>
    (entries ?? []).filter((entry) => {
      const command = (entry as { command?: string }).command ?? "";
      return !command.includes("brainfeather");
    });
  hooks.beforeSubmitPrompt = [
    ...withoutBrainfeather(hooks.beforeSubmitPrompt),
    { command: recall, timeout: 8 },
  ];
  hooks.stop = [...withoutBrainfeather(hooks.stop), { command: capture, timeout: 8 }];
  return `${JSON.stringify({ version: 1, ...current, hooks }, null, 2)}\n`;
}

export function installHostAdapters(
  target: "cursor" | "claude" | "opencode" | "all",
  home = homedir(),
  hookCommand = `npx -y @brainfeather/mcp@${VERSION}`,
): string[] {
  const written: string[] = [];
  const bin = hookCommand;
  const withBin = (contents: string) =>
    contents.replaceAll(`npx -y @brainfeather/mcp@${VERSION}`, bin);
  const wants = target === "all" ? ["cursor", "claude", "opencode"] : [target];

  if (wants.includes("cursor")) {
    const hooksPath = join(home, ".cursor", "hooks.json");
    let existing: unknown = {};
    try {
      existing = JSON.parse(readFileSync(hooksPath, "utf8"));
    } catch {
      existing = {};
    }
    writeFile(
      hooksPath,
      mergeCursorHooks(existing, `${bin} hook recall`, `${bin} hook capture`),
    );
    written.push(hooksPath);
  }

  if (wants.includes("claude")) {
    const pluginDir = join(home, ".claude", "plugins", "brainfeather");
    writeFile(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      readTemplate("hosts/claude/.claude-plugin/plugin.json"),
    );
    writeFile(join(pluginDir, "hooks", "hooks.json"), withBin(readTemplate("hosts/claude/hooks/hooks.json")));
    writeFile(
      join(pluginDir, "hooks", "recall.sh"),
      withBin(readTemplate("hosts/claude/hooks/recall.sh")),
      0o755,
    );
    writeFile(
      join(pluginDir, "hooks", "capture.sh"),
      withBin(readTemplate("hosts/claude/hooks/capture.sh")),
      0o755,
    );
    writeFile(
      join(pluginDir, "commands", "onboard.md"),
      readTemplate("hosts/claude/commands/onboard.md"),
    );
    written.push(pluginDir);
  }

  if (wants.includes("opencode")) {
    const configDir = join(home, ".config", "opencode");
    const pluginPath = join(configDir, "plugins", "brainfeather.mjs");
    writeFile(pluginPath, readTemplate("hosts/opencode/plugin.mjs"));
    writeFile(
      join(configDir, "brainfeather-plugin.mjs"),
      "// Retired Brainfeather plugin path. The adapter is auto-discovered from plugins/.\nexport default async () => ({});\n",
    );
    const configPath = join(configDir, "opencode.json");
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        plugin?: unknown[];
      };
      if (Array.isArray(config.plugin)) {
        const next = config.plugin.filter(
          (entry) =>
            typeof entry !== "string" ||
            !entry.replaceAll("\\", "/").endsWith("/brainfeather-plugin.mjs"),
        );
        if (next.length !== config.plugin.length) {
          writeFile(configPath, `${JSON.stringify({ ...config, plugin: next }, null, 2)}\n`);
        }
      }
    } catch {
      /* JSONC and project configs are left untouched; auto-discovery still works. */
    }
    written.push(pluginPath);
  }

  return written;
}
