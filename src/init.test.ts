import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installHostAdapters } from "./init.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("installHostAdapters", () => {
  it("merges fail-open Cursor hooks without dropping unrelated entries", () => {
    const home = mkdtempSync(join(tmpdir(), "brainfeather-init-"));
    temporaryPaths.push(home);
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          afterFileEdit: [{ command: "format.sh" }],
        },
      }),
    );

    const written = installHostAdapters("cursor", home, "node /tmp/brainfeather-mcp.js");
    const hooks = JSON.parse(readFileSync(written[0], "utf8")) as {
      hooks: { beforeSubmitPrompt: { command: string }[]; afterFileEdit: unknown[] };
    };
    expect(hooks.hooks.afterFileEdit).toHaveLength(1);
    expect(hooks.hooks.beforeSubmitPrompt[0]?.command).toContain("hook recall");
  });

  it("installs the OpenCode adapter in the global auto-discovery directory", () => {
    const home = mkdtempSync(join(tmpdir(), "brainfeather-init-"));
    temporaryPaths.push(home);
    const written = installHostAdapters("opencode", home);
    expect(written).toEqual([
      join(home, ".config", "opencode", "plugins", "brainfeather.mjs"),
    ]);
    expect(readFileSync(written[0], "utf8")).toContain("BrainfeatherPlugin");
  });

  it("removes the legacy explicit OpenCode plugin entry", () => {
    const home = mkdtempSync(join(tmpdir(), "brainfeather-init-"));
    temporaryPaths.push(home);
    const configDir = join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "opencode.json"),
      JSON.stringify({
        plugin: ["~/.config/opencode/brainfeather-plugin.mjs", "other-plugin"],
      }),
    );
    installHostAdapters("opencode", home);
    const config = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"));
    expect(config.plugin).toEqual(["other-plugin"]);
  });
});
