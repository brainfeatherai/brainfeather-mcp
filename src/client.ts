import { z } from "zod";
import type { Config } from "./config.js";
import { cleanMemoryText } from "./security.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const evidenceSchema = z.object({
  type: z.enum(["user", "agent", "commit", "pull_request", "issue", "file", "deployment"]),
  reference: z.string().optional(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
});

const memorySchema = z
  .object({
    $id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    content: z.string(),
    category: z.string(),
    source: z.string(),
    projectId: z.string().nullish(),
    branch: z.string().nullish(),
    taskId: z.string().nullish(),
    $createdAt: z.string().optional(),
    createdAt: z.string().optional(),
    evidence: evidenceSchema.nullish(),
  })
  .refine((value) => value.$id || value.id, { message: "memory id is required" })
  .transform((value) => ({
    $id: value.$id || value.id!,
    content: value.content,
    category: value.category,
    source: value.source,
    projectId: value.projectId,
    branch: value.branch,
    taskId: value.taskId,
    $createdAt: value.$createdAt ?? value.createdAt,
    evidence: value.evidence ?? null,
  }));

const entitySchema = z
  .object({
    $id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    name: z.string(),
    type: z.string(),
    summary: z.string().nullish(),
  })
  .refine((value) => value.$id || value.id, { message: "entity id is required" })
  .transform((value) => ({
    $id: value.$id || value.id!,
    name: value.name,
    type: value.type,
    summary: value.summary,
  }));

const edgeSchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  type: z.string().min(1),
  weight: z.number(),
});

const memoryListSchema = z.object({
  memories: z.array(memorySchema),
  count: z.number(),
});

const contextSchema = z.object({
  facts: z.array(z.string()),
  decisions: z.array(z.string()),
  patterns: z.array(z.string()),
  counts: z.object({
    facts: z.number(),
    decisions: z.number(),
    patterns: z.number(),
    total: z.number(),
  }),
  evidence: z
    .object({
      facts: z.array(evidenceSchema.nullable()),
      decisions: z.array(evidenceSchema.nullable()),
      patterns: z.array(evidenceSchema.nullable()),
    })
    .optional(),
});

const saveResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reject"), reason: z.string() }),
  z.object({ action: z.literal("duplicate"), id: z.string().min(1) }),
  z.object({
    action: z.literal("add"),
    id: z.string().min(1),
    reason: z.string(),
    invalidated: z.array(z.string().min(1)).default([]),
  }),
]);

const entityListSchema = z.object({ entities: z.array(entitySchema), count: z.number() });
const graphSchema = z.object({ entities: z.array(entitySchema), edges: z.array(edgeSchema) });
const deleteSchema = z.object({ deleted: z.string().min(1) });
const contextResponseSchema = contextSchema.extend({
  sessionToken: z.string().min(8).max(4000).optional(),
  proactiveRecall: z.boolean().optional(),
});
const captureResultSchema = z.object({
  candidates: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  saved: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  sessionToken: z.string().min(8).max(4000).optional(),
});
const reviewQueueSchema = z.object({
  candidates: z.array(
    z.object({
      $id: z.string().min(1),
      content: z.string(),
      category: z.string(),
      status: z.string(),
      projectId: z.string().nullish(),
      branch: z.string().nullish(),
      taskId: z.string().nullish(),
      $createdAt: z.string().optional(),
    }),
  ),
});

const TIMEOUT_MS = 30_000;
const RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

type CallOptions = {
  signal?: AbortSignal;
  retry?: boolean;
  sessionToken?: string | null;
};

export type MemoryScope = {
  projectId?: string;
  branch?: string;
  taskId?: string;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

function retryAfterMs(value: string | null): number {
  if (!value) return 2000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 30_000) : 2000;
}

export class Client {
  private readonly sessionTokens = new Map<string, string>();

  constructor(
    private readonly cfg: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private scopeKey(scope: MemoryScope): string {
    return JSON.stringify([
      scope.projectId ?? null,
      scope.branch ?? null,
      scope.taskId ?? null,
    ]);
  }

  private rememberSession(scope: MemoryScope, token?: string) {
    if (token) this.sessionTokens.set(this.scopeKey(scope), token);
  }

  private sessionFor(scope: MemoryScope): string | undefined {
    return this.sessionTokens.get(this.scopeKey(scope));
  }

  private clearSession(scope: MemoryScope, expected?: string) {
    const key = this.scopeKey(scope);
    if (expected === undefined || this.sessionTokens.get(key) === expected) {
      this.sessionTokens.delete(key);
    }
  }

  private async call<Schema extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: Schema,
    body?: unknown,
    options: CallOptions = {},
  ): Promise<z.output<Schema>> {
    const mayRetry = options.retry ?? method === "GET";
    let lastError: ApiError | undefined;
    let retryDelay = 0;

    for (let attempt = 0; attempt <= (mayRetry ? RETRIES : 0); attempt++) {
      if (attempt > 0) {
        try {
          await sleep(retryDelay || 500 * 2 ** (attempt - 1), options.signal);
        } catch {
          throw new ApiError("Brainfeather request cancelled.");
        }
        retryDelay = 0;
      }

      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS);

      let res: Response;
      try {
        const sessionToken = options.sessionToken;
        res = await this.fetchImpl(`${this.cfg.apiUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            ...(sessionToken
              ? { "x-brainfeather-session": sessionToken }
              : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal,
        });
      } catch {
        if (options.signal?.aborted) throw new ApiError("Brainfeather request cancelled.");
        lastError = new ApiError(
          `Cannot reach Brainfeather at ${this.cfg.apiUrl}. Check the connection, or BRAINFEATHER_API_URL if self-hosting.`,
          true,
        );
        if (attempt < (mayRetry ? RETRIES : 0)) {
          retryDelay = 500 * 2 ** attempt;
          continue;
        }
        throw lastError;
      }

      if (res.status === 401) {
        throw new ApiError(
          "Token rejected. It may have been revoked - generate a new one at https://brainfeather.com/api-keys",
          false,
          401,
        );
      }

      if (res.status === 429 || RETRYABLE_STATUS.has(res.status)) {
        const detail = await this.errorDetail(res);
        lastError = new ApiError(detail ?? `Brainfeather returned ${res.status}.`, true, res.status);
        if (attempt < (mayRetry ? RETRIES : 0)) {
          retryDelay =
            res.status === 429
              ? retryAfterMs(res.headers.get("retry-after"))
              : 500 * 2 ** attempt;
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        throw new ApiError(
          (await this.errorDetail(res)) ?? `Brainfeather returned ${res.status}.`,
          false,
          res.status,
        );
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        lastError = new ApiError(
          "Brainfeather returned an invalid JSON response.",
          true,
          res.status,
        );
        if (attempt < (mayRetry ? RETRIES : 0)) {
          retryDelay = 500 * 2 ** attempt;
          continue;
        }
        throw lastError;
      }

      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          `Brainfeather returned an unexpected response shape: ${parsed.error.issues[0]?.message ?? "validation failed"}.`,
        );
      }
      return parsed.data;
    }

    throw lastError ?? new ApiError("Brainfeather request failed.", true);
  }

  private async errorDetail(res: Response): Promise<string | null> {
    return res
      .json()
      .then((json) => {
        const value = (json as { error?: unknown }).error;
        return typeof value === "string" ? cleanMemoryText(value).slice(0, 500) : null;
      })
      .catch(() => null);
  }

  private query(params: Record<string, string | number | boolean | undefined>): string {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    const query = qs.toString();
    return query ? `?${query}` : "";
  }

  searchMemories(
    query: string,
    opts: {
      category?: string;
      projectId?: string;
      branch?: string;
      taskId?: string;
      limit?: number;
      strictScope?: boolean;
      referenceAt?: string;
      includeEvidence?: boolean;
    },
    signal?: AbortSignal,
  ) {
    return this.call(
      "GET",
      `/memories/search${this.query({ q: query, ...opts })}`,
      memoryListSchema,
      undefined,
      { signal },
    );
  }

  saveMemory(
    fact: {
      content: string;
      category: string;
      source?: string;
      title?: string;
      projectId: string;
      branch?: string;
      taskId?: string;
      supersedesId?: string;
      observedAt?: string;
      validFrom?: string;
      validTo?: string;
      temporalType?: "state" | "event" | "plan" | "preference" | "decision" | "absence";
      confidence?: number;
      provenance:
        | "user_stated"
        | {
            type: "user" | "agent" | "commit" | "pull_request" | "issue" | "file" | "deployment";
            reference?: string;
            digest?: string;
          };
    },
    signal?: AbortSignal,
  ) {
    return this.call("POST", "/memories", saveResultSchema, fact, { signal, retry: false });
  }

  forgetMemory(
    id: string,
    projectId: string,
    signal?: AbortSignal,
    scope: Pick<MemoryScope, "branch" | "taskId"> = {},
  ) {
    return this.call(
      "DELETE",
      `/memories/${encodeURIComponent(id)}${this.query({ projectId, ...scope })}`,
      deleteSchema,
      undefined,
      { signal, retry: false },
    );
  }

  getContext(
    projectId?: string,
    strictScope = false,
    signal?: AbortSignal,
    options: {
      query?: string;
      referenceAt?: string;
      maxTokens?: number;
      includeEvidence?: boolean;
      retry?: boolean;
      branch?: string;
      taskId?: string;
    } = {},
  ) {
    const { retry, ...queryOptions } = options;
    const scope = {
      projectId,
      branch: options.branch,
      taskId: options.taskId,
    };
    const request = (sessionToken: string | null | undefined) =>
      this.call(
        "GET",
        `/context${this.query({ projectId, strictScope, ...queryOptions })}`,
        contextResponseSchema,
        undefined,
        { signal, retry, sessionToken },
      );
    const sentToken = this.sessionFor(scope);
    return request(sentToken).catch((error: unknown) => {
      if (
        sentToken &&
        error instanceof ApiError &&
        error.status === 400 &&
        /sessionToken is invalid/i.test(error.message)
      ) {
        this.clearSession(scope, sentToken);
        return request(this.sessionFor(scope) ?? null);
      }
      throw error;
    }).then((result) => {
      this.rememberSession(scope, result.sessionToken);
      return result;
    });
  }

  captureActivity(
    input: {
      activity: string;
      projectId?: string;
      branch?: string;
      taskId?: string;
      source?: string;
    },
    signal?: AbortSignal,
  ) {
    const request = (sessionToken: string | null | undefined) =>
      this.call(
        "POST",
        "/capture",
        captureResultSchema,
        {
          activity: input.activity,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.source ? { source: input.source } : {}),
          ...(sessionToken ? { sessionToken } : {}),
        },
        { signal, retry: false, sessionToken },
      );
    const scope = {
      projectId: input.projectId,
      branch: input.branch,
      taskId: input.taskId,
    };
    const sentToken = this.sessionFor(scope);
    return request(sentToken).catch((error: unknown) => {
      if (
        sentToken &&
        error instanceof ApiError &&
        error.status === 400 &&
        /sessionToken is invalid/i.test(error.message)
      ) {
        this.clearSession(scope, sentToken);
        return request(this.sessionFor(scope) ?? null);
      }
      throw error;
    }).then((result) => {
      this.rememberSession(scope, result.sessionToken);
      return result;
    });
  }

  listEntities(
    type?: string,
    projectId?: string,
    strictScope = false,
    signal?: AbortSignal,
    scope: Pick<MemoryScope, "branch" | "taskId"> = {},
  ) {
    return this.call(
      "GET",
      `/entities${this.query({ type, projectId, strictScope, ...scope })}`,
      entityListSchema,
      undefined,
      { signal },
    );
  }

  listReviewQueue(
    projectId?: string,
    signal?: AbortSignal,
    scope: Pick<MemoryScope, "branch" | "taskId"> = {},
  ) {
    return this.call(
      "GET",
      `/memory-candidates${this.query({ status: "pending", projectId, ...scope, limit: 25 })}`,
      reviewQueueSchema,
      undefined,
      { signal },
    );
  }

  traverse(
    entityId: string,
    depth?: number,
    projectId?: string,
    strictScope = false,
    signal?: AbortSignal,
    scope: Pick<MemoryScope, "branch" | "taskId"> = {},
  ) {
    return this.call(
      "GET",
      `/graph/traverse/${encodeURIComponent(entityId)}${this.query({ depth, projectId, strictScope, ...scope })}`,
      graphSchema,
      undefined,
      { signal },
    );
  }
}

export type Memory = z.infer<typeof memorySchema>;
export type Entity = z.infer<typeof entitySchema>;
export type Edge = z.infer<typeof edgeSchema>;
export type SaveResult = z.infer<typeof saveResultSchema>;
export type ContextResult = z.infer<typeof contextResponseSchema>;
export type CaptureResult = z.infer<typeof captureResultSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
