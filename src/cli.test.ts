import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("defaults to stdio for MCP client launches", () => {
    expect(parseArgs([])).toEqual({ kind: "stdio" });
  });

  it("parses streamable HTTP flags", () => {
    expect(parseArgs(["--http", "--port", "9000", "--host", "localhost"])).toEqual({
      kind: "http",
      host: "localhost",
      port: 9000,
    });
  });

  it("refuses to expose the credential-bearing local HTTP server", () => {
    expect(() => parseArgs(["--http", "--host", "0.0.0.0"])).toThrow(
      /only bind to localhost/,
    );
  });

  it("normalizes bracketed IPv6 loopback for server.listen", () => {
    expect(parseArgs(["--http", "--host", "[::1]"])).toMatchObject({ host: "::1" });
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
