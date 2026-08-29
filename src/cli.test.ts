import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("defaults to stdio for MCP client launches", () => {
    expect(parseArgs([])).toEqual({ kind: "stdio" });
  });

  it("parses streamable HTTP flags", () => {
    expect(parseArgs(["--http", "--port", "9000", "--host", "0.0.0.0"])).toEqual({
      kind: "http",
      host: "0.0.0.0",
      port: 9000,
    });
  });

  it("parses hook and init commands", () => {
    expect(parseArgs(["hook", "recall", "--format", "claude"])).toEqual({
      kind: "hook",
      name: "recall",
      format: "claude",
    });
    expect(parseArgs(["init", "cursor"])).toEqual({ kind: "init", target: "cursor" });
  });

  it("rejects unknown commands", () => {
    expect(() => parseArgs(["publish"])).toThrow(/Usage: brainfeather-mcp/);
  });
});
