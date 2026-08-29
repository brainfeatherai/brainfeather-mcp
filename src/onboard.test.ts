import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractOnboardFacts } from "./onboard.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("extractOnboardFacts", () => {
  it("imports durable instruction-file lines and skips chatter", () => {
    const root = mkdtempSync(join(tmpdir(), "brainfeather-onboard-"));
    temporaryPaths.push(root);
    writeFileSync(
      join(root, "AGENTS.md"),
      ["# Agents", "", "Hello.", "", "- This project uses Vitest for unit tests.", "- Be nice."].join(
        "\n",
      ),
    );
    mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "rules", "stack.mdc"),
      "We decided to store sessions as signed tokens.\n",
    );

    const facts = extractOnboardFacts(root);
    expect(facts.map((fact) => fact.content)).toEqual([
      "This project uses Vitest for unit tests.",
      "We decided to store sessions as signed tokens.",
    ]);
    expect(facts[0]?.reference).toBe("AGENTS.md");
  });
});
