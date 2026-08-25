import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(join(tmpdir(), "brainfeather-cli-"));
try {
  const link = join(directory, "brainfeather-mcp");
  symlinkSync(resolve("dist/index.js"), link);
  const result = spawnSync(process.execPath, [link], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: directory },
  });
  if (result.status !== 1 || !result.stderr.includes("Missing BRAINFEATHER_API_KEY")) {
    throw new Error(
      `Packed CLI did not start through its symlink. status=${result.status}\nstderr=${result.stderr}`,
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
