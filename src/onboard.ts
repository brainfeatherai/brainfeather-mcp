import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { secretReason } from "./security.js";

export const ONBOARD_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "GEMINI.md",
] as const;

const DURABLE_SIGNAL =
  /\b(?:decided|chose|picked|switched|migrated|uses?|using|built with|configured|requires?|prefers?|always|never|convention|standard|architecture|prefer|must|should|do not|don't)\b/i;

const CATEGORY_HINT: Array<{ pattern: RegExp; category: OnboardFact["category"] }> = [
  { pattern: /\b(prefer|always|never|style|tone)\b/i, category: "preference" },
  { pattern: /\b(decid|chose|picked|migrat|switch)\b/i, category: "decision" },
  { pattern: /\b(test|lint|format|convention|pattern)\b/i, category: "code" },
  { pattern: /\b(project|repo|stack|framework|database|deploy)\b/i, category: "project" },
];

export type OnboardFact = {
  content: string;
  category: "preference" | "context" | "decision" | "code" | "project" | "team";
  reference: string;
};

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function categoryFor(content: string): OnboardFact["category"] {
  for (const hint of CATEGORY_HINT) {
    if (hint.pattern.test(content)) return hint.category;
  }
  return "context";
}

function linesFromMarkdown(text: string): string[] {
  const collected: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/^#+\s+/, "").trim();
    if (line.length < 12 || line.length > 400) continue;
    if (/^```/.test(raw.trim())) continue;
    collected.push(line.replace(/\s+/g, " "));
  }
  return collected;
}

function cursorRuleFiles(workspaceRoot: string): string[] {
  const directory = join(workspaceRoot, ".cursor", "rules");
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".md") || name.endsWith(".mdc"))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** Extract user-stated durable facts from repo instruction files. Caps at 20. */
export function extractOnboardFacts(workspaceRoot: string, limit = 20): OnboardFact[] {
  const files = [
    ...ONBOARD_FILES.map((name) => join(workspaceRoot, name)),
    ...cursorRuleFiles(workspaceRoot),
  ];
  const seen = new Set<string>();
  const facts: OnboardFact[] = [];

  for (const path of files) {
    const text = readOptional(path);
    if (!text) continue;
    const reference = path.slice(workspaceRoot.length).replace(/^[\\/]/, "") || path;
    for (const line of linesFromMarkdown(text)) {
      if (secretReason(line) || !DURABLE_SIGNAL.test(line)) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({ content: line, category: categoryFor(line), reference });
      if (facts.length >= limit) return facts;
    }
  }

  return facts;
}
