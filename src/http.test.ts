import { describe, expect, it } from "vitest";
import { handleStreamableRequest } from "./http.js";

const config = {
  apiKey: "bf_test_1234567890abcdef",
  apiUrl: "https://brainfeather.example/api/v1",
  projectId: "github.com/acme/app",
};

describe("handleStreamableRequest", () => {
  it("answers CORS preflight without touching the API", async () => {
    const response = await handleStreamableRequest(
      new Request("http://127.0.0.1/mcp", { method: "OPTIONS" }),
      config,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects non-loopback hosts and browser origins", async () => {
    const hostResponse = await handleStreamableRequest(
      new Request("http://attacker.example/mcp", { method: "OPTIONS" }),
      config,
    );
    expect(hostResponse.status).toBe(403);

    const originResponse = await handleStreamableRequest(
      new Request("http://127.0.0.1/mcp", {
        method: "OPTIONS",
        headers: { origin: "https://attacker.example" },
      }),
      config,
    );
    expect(originResponse.status).toBe(403);
  });

  it("initializes a stateless JSON MCP session", async () => {
    const response = await handleStreamableRequest(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          host: "127.0.0.1",
          "x-brainfeather-project": "github.com/acme/app",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "cursor", version: "1.0.0" },
          },
        }),
      }),
      config,
    );
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as {
      result?: { serverInfo?: { name?: string; version?: string } };
    };
    expect(payload.result?.serverInfo?.name).toBe("brainfeather");
    expect(payload.result?.serverInfo?.version).toBe("1.6.1");
  });
});
