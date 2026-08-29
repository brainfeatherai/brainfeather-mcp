import { describe, expect, it, vi } from "vitest";
import { Client } from "./client.js";
import { runHook } from "./hook.js";

const config = {
  apiKey: "bf_test_1234567890abcdef",
  apiUrl: "https://brainfeather.example/api/v1",
  projectId: "github.com/acme/app",
};

describe("runHook", () => {
  it("injects recalled context for Cursor and fails open on errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        facts: ["Backend is Appwrite."],
        decisions: [],
        patterns: [],
        counts: { facts: 1, decisions: 0, patterns: 0, total: 1 },
      }),
    );
    const output = await runHook(
      "recall",
      "cursor",
      JSON.stringify({ prompt: "How should auth work in this app?" }),
      { config, client: new Client(config, fetchMock) },
    );
    expect(JSON.parse(output)).toMatchObject({
      additional_context: expect.stringContaining("Backend is Appwrite."),
    });

    const failed = await runHook("recall", "cursor", "{", {
      config,
      client: new Client(config, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))),
    });
    expect(JSON.parse(failed)).toEqual({});
  });

  it("queues capture without looping the agent", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        candidates: 1,
        queued: 1,
        saved: 0,
        duplicates: 0,
        rejected: 0,
      }),
    );
    const output = await runHook(
      "capture",
      "claude",
      JSON.stringify({
        text: "This project uses Xcode for the iOS client and keeps Node for tooling.",
      }),
      { config, client: new Client(config, fetchMock) },
    );
    expect(JSON.parse(output)).toEqual({});
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/capture");
  });
});
