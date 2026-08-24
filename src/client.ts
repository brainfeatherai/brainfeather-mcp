/* ────────────────────────────────────────────────────────────────
   HTTP client for the Brainfeather API.

   The only credential this package ever sends is a bf_live_ API key,
   which the server resolves to one account. No database driver, no
   admin credentials — that is what makes it safe to `npx`.

   Errors are phrased for an AGENT, not for a developer reading a stack
   trace. An agent handed "fetch failed" retries pointlessly; one told
   "the API is unreachable" can say something useful to the user.

   Uses global fetch, hence Node 18+ in engines. No polyfill.
   ──────────────────────────────────────────────────────────────── */

import type { Config } from "./config.js";

export class ApiError extends Error {}

export class Client {
  constructor(private cfg: Config) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      /* DNS failure, refused connection, offline. Naming the URL matters
         because the usual cause is a self-hoster pointing at a dev
         server that is not running. */
      throw new ApiError(
        `Cannot reach Brainfeather at ${this.cfg.apiUrl}. Check the connection, or BRAINFEATHER_API_URL if self-hosting.`,
      );
    }

    if (res.status === 401) {
      throw new ApiError(
        "Token rejected. It may have been revoked — generate a new one at https://brainfeather.com/settings",
      );
    }

    if (!res.ok) {
      /* Surface the API's own message when it sent one: for a 400 that
         is the actionable part ("category must be one of…"). */
      const detail = await res
        .json()
        .then((j) => (j as { error?: string }).error)
        .catch(() => null);
      throw new ApiError(detail ?? `Brainfeather returned ${res.status}.`);
    }

    return (await res.json()) as T;
  }

  private query(params: Record<string, string | number | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    const s = qs.toString();
    return s ? `?${s}` : "";
  }

  /* ── Memories ─────────────────────────────────────────────────── */

  listMemories(opts: { category?: string; projectId?: string; limit?: number }) {
    return this.call<{ memories: Memory[]; count: number }>(
      "GET",
      `/memories${this.query(opts)}`,
    );
  }

  searchMemories(q: string, opts: { category?: string; projectId?: string; limit?: number }) {
    return this.call<{ memories: Memory[]; count: number }>(
      "GET",
      `/memories/search${this.query({ q, ...opts })}`,
    );
  }

  saveMemory(fact: {
    content: string;
    category: string;
    source?: string;
    title?: string;
    projectId?: string;
  }) {
    return this.call<SaveResult>("POST", "/memories", fact);
  }

  forgetMemory(id: string) {
    return this.call<{ deleted: string }>("DELETE", `/memories/${encodeURIComponent(id)}`);
  }

  getContext(projectId?: string) {
    return this.call<ContextResult>("GET", `/context${this.query({ projectId })}`);
  }

  /* ── Graph ────────────────────────────────────────────────────── */

  listEntities(type?: string) {
    return this.call<{ entities: Entity[]; count: number }>(
      "GET",
      `/entities${this.query({ type })}`,
    );
  }

  traverse(entityId: string, depth?: number) {
    return this.call<{ entities: Entity[]; edges: Edge[] }>(
      "GET",
      `/graph/traverse/${encodeURIComponent(entityId)}${this.query({ depth })}`,
    );
  }
}

/* ── Shapes returned by the API ─────────────────────────────────── */

export type Memory = {
  $id: string;
  content: string;
  category: string;
  source: string;
  $createdAt?: string;
};

export type Entity = { $id: string; name: string; type: string; summary?: string };
export type Edge = { sourceId: string; targetId: string; type: string; weight: number };

export type SaveResult = {
  action: "add" | "duplicate" | "reject";
  id?: string;
  reason?: string;
  invalidated?: string[];
};

export type ContextResult = {
  facts: string[];
  decisions: string[];
  patterns: string[];
  counts: { facts: number; decisions: number; patterns: number; total: number };
};
