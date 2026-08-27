import { describe, expect, it, vi } from "vitest";
import { ApiError, Client } from "./client.js";

const config = {
  apiKey: "bf_test_1234567890abcdef",
  apiUrl: "https://brainfeather.example/api/v1",
};

const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

describe("Client", () => {
  it("retries transient failures for reads", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: "cold start" }, { status: 503 }))
      .mockResolvedValueOnce(
        json({
          facts: [],
          decisions: [],
          patterns: [],
          counts: { facts: 0, decisions: 0, patterns: 0, total: 0 },
        }),
      );
    const client = new Client(config, fetchMock);

    await expect(client.getContext("project", true)).resolves.toMatchObject({
      counts: { total: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry destructive deletes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "gateway timeout" }, { status: 504 }));
    const client = new Client(config, fetchMock);

    await expect(client.forgetMemory("memory-1", "project")).rejects.toMatchObject({
      retryable: true,
      status: 504,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry saves after an uncertain network failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const client = new Client(config, fetchMock);

    await expect(
      client.saveMemory({
        content: "This project uses Vitest.",
        category: "code",
        projectId: "project",
        provenance: "user_stated",
      }),
    ).rejects.toMatchObject({ retryable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects empty preferred ids instead of hiding a valid fallback", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        memories: [
          {
            $id: "",
            id: "valid-id",
            content: "This project uses Vitest.",
            category: "code",
            source: "opencode",
          },
        ],
        count: 1,
      }),
    );
    const client = new Client(config, fetchMock);
    await expect(
      client.searchMemories("testing", { projectId: "project", strictScope: true }),
    ).rejects.toThrow("unexpected response shape");
  });

  it("sends project-scoped search options and preserves API ranking order", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        memories: [
          {
            $id: "ranked-first",
            content: "Supabase RLS policies enforce permissions.",
            category: "decision",
            source: "manual",
          },
          {
            $id: "ranked-second",
            content: "Authentication uses sessions.",
            category: "decision",
            source: "manual",
          },
        ],
        count: 2,
      }),
    );
    const client = new Client(config, fetchMock);

    const result = await client.searchMemories("how do we handle auth", {
      category: "decision",
      projectId: "github.com/acme/app",
      limit: 7,
      strictScope: true,
    });

    expect(result.memories.map((memory) => memory.$id)).toEqual([
      "ranked-first",
      "ranked-second",
    ]);
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe("/api/v1/memories/search");
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      q: "how do we handle auth",
      category: "decision",
      projectId: "github.com/acme/app",
      limit: "7",
      strictScope: "true",
    });
  });

  it("validates successful API response shapes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ facts: "wrong" }));
    const client = new Client(config, fetchMock);

    await expect(client.getContext("project", true)).rejects.toThrow(
      "unexpected response shape",
    );
  });

  it("stops immediately when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const client = new Client(config, fetchMock);

    await expect(client.getContext("project", true, controller.signal)).rejects.toThrow(
      "Brainfeather request cancelled.",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
