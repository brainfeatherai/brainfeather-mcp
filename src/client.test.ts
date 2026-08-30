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
      branch: "feature/auth",
      taskId: "task-42",
      limit: 7,
      strictScope: true,
      referenceAt: "2026-01-01T00:00:00.000Z",
      includeEvidence: true,
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
      branch: "feature/auth",
      taskId: "task-42",
      limit: "7",
      strictScope: "true",
      referenceAt: "2026-01-01T00:00:00.000Z",
      includeEvidence: "true",
    });
  });

  it("forwards query-aware context options without changing the response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        facts: ["Production uses Vercel."],
        decisions: [],
        patterns: [],
        counts: { facts: 1, decisions: 0, patterns: 0, total: 1 },
      }),
    );
    const client = new Client(config, fetchMock);

    await expect(
      client.getContext("github.com/acme/app", true, undefined, {
        query: "deployment",
        branch: "feature/auth",
        taskId: "task-42",
        referenceAt: "2026-01-01T00:00:00.000Z",
        maxTokens: 1024,
      }),
    ).resolves.toMatchObject({ counts: { total: 1 } });

    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      projectId: "github.com/acme/app",
      strictScope: "true",
      branch: "feature/auth",
      taskId: "task-42",
      query: "deployment",
      referenceAt: "2026-01-01T00:00:00.000Z",
      maxTokens: "1024",
    });
  });

  it("sends temporal and evidence metadata on saves", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({ action: "add", id: "memory-1", reason: "new decision", invalidated: [] }),
    );
    const client = new Client(config, fetchMock);
    const fact = {
      content: "The API moved to Vercel.",
      category: "decision",
      projectId: "github.com/acme/app",
      observedAt: "2026-01-10T00:00:00.000Z",
      validFrom: "2026-01-01T00:00:00.000Z",
      temporalType: "decision" as const,
      confidence: 0.95,
      provenance: {
        type: "file" as const,
        reference: "docs/architecture.md",
        digest: `sha256:${"a".repeat(64)}`,
      },
    };

    await client.saveMemory(fact);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual(fact);
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

  it("round-trips session tokens from context into capture", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          facts: [],
          decisions: [],
          patterns: [],
          counts: { facts: 0, decisions: 0, patterns: 0, total: 0 },
          sessionToken: "session.token.value",
          proactiveRecall: true,
        }),
      )
      .mockResolvedValueOnce(
        json({
          candidates: 1,
          queued: 1,
          saved: 0,
          duplicates: 0,
          rejected: 0,
          sessionToken: "session.token.value.2",
        }),
      );
    const client = new Client(config, fetchMock);

    await client.getContext("github.com/acme/app", true);
    await client.captureActivity({
      activity: "This project uses Vitest for unit tests.",
      projectId: "github.com/acme/app",
      source: "opencode",
    });

    const contextHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(contextHeaders.get("x-brainfeather-session")).toBeNull();

    const captureInit = fetchMock.mock.calls[1]?.[1];
    const captureHeaders = new Headers(captureInit?.headers);
    expect(captureHeaders.get("x-brainfeather-session")).toBe("session.token.value");
    expect(JSON.parse(String(captureInit?.body))).toMatchObject({
      activity: "This project uses Vitest for unit tests.",
      projectId: "github.com/acme/app",
      source: "opencode",
      sessionToken: "session.token.value",
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://brainfeather.example/api/v1/capture",
    );
  });

  it("keeps session tokens isolated by repository, branch, and task", async () => {
    const context = {
      facts: [],
      decisions: [],
      patterns: [],
      counts: { facts: 0, decisions: 0, patterns: 0, total: 0 },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...context, sessionToken: "main.task-a.token" }))
      .mockResolvedValueOnce(json({ ...context, sessionToken: "feature.task-a.token" }))
      .mockResolvedValueOnce(
        json({ candidates: 0, queued: 0, saved: 0, duplicates: 0, rejected: 0 }),
      )
      .mockResolvedValueOnce(
        json({ candidates: 0, queued: 0, saved: 0, duplicates: 0, rejected: 0 }),
      );
    const client = new Client(config, fetchMock);

    await client.getContext("project", true, undefined, { branch: "main", taskId: "task-a" });
    await client.getContext("project", true, undefined, {
      branch: "feature/auth",
      taskId: "task-a",
    });
    await client.captureActivity({
      activity: "This project uses Vitest for tests.",
      projectId: "project",
      branch: "main",
      taskId: "task-a",
    });
    await client.captureActivity({
      activity: "This project uses Vitest for tests.",
      projectId: "project",
      branch: "feature/auth",
      taskId: "task-a",
    });

    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("x-brainfeather-session")).toBe(
      "main.task-a.token",
    );
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get("x-brainfeather-session")).toBe(
      "feature.task-a.token",
    );
  });

  it("does not retry capture after a transient failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "gateway timeout" }, { status: 504 }));
    const client = new Client(config, fetchMock);

    await expect(
      client.captureActivity({ activity: "This project uses Vitest." }),
    ).rejects.toMatchObject({ retryable: true, status: 504 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("renegotiates once when the server rejects an expired session", async () => {
    const context = {
      facts: [],
      decisions: [],
      patterns: [],
      counts: { facts: 0, decisions: 0, patterns: 0, total: 0 },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...context, sessionToken: "expired.session.token" }))
      .mockResolvedValueOnce(json({ error: "sessionToken is invalid." }, { status: 400 }))
      .mockResolvedValueOnce(json({ ...context, sessionToken: "fresh.session.token" }));
    const client = new Client(config, fetchMock);

    await client.getContext("project", true);
    await expect(client.getContext("project", true)).resolves.toMatchObject(context);

    const rejectedHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    const retriedHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);
    expect(rejectedHeaders.get("x-brainfeather-session")).toBe("expired.session.token");
    expect(retriedHeaders.get("x-brainfeather-session")).toBeNull();
  });

  it("does not clear a fresh session when a concurrent stale request finishes late", async () => {
    const context = {
      facts: [],
      decisions: [],
      patterns: [],
      counts: { facts: 0, decisions: 0, patterns: 0, total: 0 },
    };
    let rejectLate!: (value: Response) => void;
    const late = new Promise<Response>((resolve) => { rejectLate = resolve; });
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls++;
      if (calls === 1) return json({ ...context, sessionToken: "stale.session.token" });
      if (calls === 2) return late;
      if (calls === 3) return json({ error: "sessionToken is invalid." }, { status: 400 });
      if (calls === 4) return json({ ...context, sessionToken: "fresh.session.token" });
      return json({ ...context, sessionToken: "fresh.session.token" });
    });
    const client = new Client(config, fetchMock);
    await client.getContext("project", true);

    const first = client.getContext("project", true);
    const second = client.getContext("project", true);
    await second;
    rejectLate(json({ error: "sessionToken is invalid." }, { status: 400 }));
    await first;

    const finalHeaders = new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers);
    expect(finalHeaders.get("x-brainfeather-session")).toBe("fresh.session.token");
  });
});
