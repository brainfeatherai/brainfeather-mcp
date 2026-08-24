#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────
   Brainfeather MCP server — long-term memory for coding agents.

   Talks to the Brainfeather API over HTTPS with a revocable bf_live_
   token. It holds no database credentials; the previous version shipped
   a full-scope Appwrite admin key, which is why it could not be
   published.

   TWO deliberate design choices, both from measurement rather than
   taste:

   1. Responses are terse lines, not pretty JSON. Three memories measured
      713 characters as JSON.stringify(…, null, 2) and 131 as lines.
      Everything here lands in a context window, so format is a feature.

      Characters, not tokens — the token ratio is smaller and has not
      been measured.

   2. Descriptions lead with WHEN to call, not what the tool does. The
      failure mode for a memory server is not a broken tool, it is an
      agent that never invokes one — it answers from an empty context and
      the user re-explains their stack for the tenth time. The
      description is the only lever on that, so each one opens with its
      trigger.

   Six tools, down from ten. Fewer tools measurably improves selection
   accuracy, and four of the originals did not earn a slot in an agent's
   context: list_memories was search_memory with no query; create_entity
   and connect_entities hand-mutated a graph that save_memory already
   builds automatically; memory_stats answered a dashboard question, and
   get_context already returns the counts. All four remain reachable over
   the HTTP API, where listing them costs no context.
   ──────────────────────────────────────────────────────────────── */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiError, Client } from "./client.js";
import { loadConfig } from "./config.js";
import {
  contextBlock,
  decisionLine,
  entityLines,
  graphBlock,
  memoryLines,
} from "./format.js";

const client = new Client(loadConfig());
const server = new McpServer({ name: "brainfeather", version: "1.0.0" });

const CATEGORIES = [
  "preference",
  "context",
  "decision",
  "code",
  "project",
  "team",
] as const;

const ENTITY_TYPES = [
  "tool",
  "language",
  "concept",
  "person",
  "project",
  "pattern",
] as const;

/** Plain text out. `isError` lets the agent distinguish a failed call
    from a successful one that found nothing. */
function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

/* An ApiError already carries an agent-readable sentence; anything else
   is unexpected and gets a generic line rather than a leaked stack. */
async function attempt(work: () => Promise<string>) {
  try {
    return text(await work());
  } catch (err) {
    if (err instanceof ApiError) return text(err.message, true);
    return text("Brainfeather failed unexpectedly. Try again.", true);
  }
}

/* ── Read ───────────────────────────────────────────────────────── */

server.registerTool(
  "get_context",
  {
    description:
      "Call this FIRST, before writing code or answering anything about this project. " +
      "Returns the user's stack, decisions and conventions already on record, so you do " +
      "not ask what they have told you before or scaffold against the wrong framework. " +
      "Cheap: a few hundred tokens. Returns nothing if this is a fresh project.",
    inputSchema: {
      projectId: z
        .string()
        .optional()
        .describe("Scope to one project. Omit for everything."),
    },
  },
  ({ projectId }) =>
    attempt(async () => contextBlock(await client.getContext(projectId))),
);

server.registerTool(
  "search_memory",
  {
    description:
      "Look up what the user has already decided about a specific topic. Call this before " +
      "choosing a library, pattern or tool on their behalf, and whenever they refer to a " +
      "past decision. Returns matching facts newest first, each prefixed by its id.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe("Topic, e.g. 'auth' or 'testing framework'. Keywords beat sentences."),
      category: z.enum(CATEGORIES).optional(),
      projectId: z.string().optional(),
      limit: z.number().int().min(1).max(25).optional().describe("Default 10."),
    },
  },
  ({ query, ...opts }) =>
    attempt(async () => memoryLines((await client.searchMemories(query, opts)).memories)),
);

server.registerTool(
  "list_entities",
  {
    description:
      "List the tools, languages and concepts appearing across the user's memories. " +
      "Use to get the shape of a project quickly, or to find an entity id for " +
      "traverse_graph. Entities are extracted automatically when facts are saved.",
    inputSchema: { type: z.enum(ENTITY_TYPES).optional() },
  },
  ({ type }) =>
    attempt(async () => entityLines((await client.listEntities(type)).entities)),
);

server.registerTool(
  "traverse_graph",
  {
    description:
      "Show what connects to one entity — which memories mention it and which other " +
      "entities relate to it. Use when a change to one tool might affect others. " +
      "Takes an entity id from list_entities.",
    inputSchema: {
      entityId: z.string().describe("Entity id from list_entities."),
      depth: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("Hops to follow. Default 1. Higher is slower."),
    },
  },
  ({ entityId, depth }) =>
    attempt(async () => graphBlock(await client.traverse(entityId, depth))),
);

/* ── Write ──────────────────────────────────────────────────────── */

server.registerTool(
  "save_memory",
  {
    description:
      "Record something durable the user just told you: a stack choice, a convention, a " +
      "preference, or a correction of an earlier decision. Call it the moment such a fact " +
      "appears — do not wait for the end of the session or for permission.\n\n" +
      "Safe to call freely. The server filters small talk, drops duplicates, and retracts " +
      "facts this one contradicts, so a wrong guess costs nothing. The reply says which " +
      "happened.\n\n" +
      "Write ONE self-contained sentence that will still make sense with no conversation " +
      "around it. Good: 'This project uses Supabase for auth with row-level security.' " +
      "Bad: 'use that instead' — meaningless next week.\n\n" +
      "Do NOT save: what you are about to do, transient state, one-off commands, or " +
      "anything true only right now.",
    inputSchema: {
      content: z
        .string()
        .min(3)
        .max(2000)
        .describe("One standalone sentence stating the fact."),
      category: z
        .enum(CATEGORIES)
        .describe(
          "decision = a choice made. code = a convention. preference = how they like to " +
            "work. project = what it is. context = background. team = who does what.",
        ),
      source: z
        .string()
        .optional()
        .describe("Which client you are, e.g. 'claude', 'cursor', 'opencode'."),
      title: z.string().max(120).optional(),
      projectId: z.string().optional(),
    },
  },
  (input) => attempt(async () => decisionLine(await client.saveMemory(input))),
);

server.registerTool(
  "forget_memory",
  {
    description:
      "Delete a memory permanently, when the user says something should not have been " +
      "recorded. Takes the id shown in search_memory or get_context output.\n\n" +
      "You rarely need this: saving a corrected fact retracts what it contradicts " +
      "automatically, and keeps the history. Prefer save_memory for 'actually, we " +
      "switched to X'. Use this only for something recorded in error.",
    inputSchema: { id: z.string().describe("Memory id.") },
  },
  ({ id }) =>
    attempt(async () => {
      await client.forgetMemory(id);
      return `Deleted ${id}.`;
    }),
);

/* ── Prompt ─────────────────────────────────────────────────────── */

/* A slash-command entry point, so a user can pull context deliberately
   instead of relying on the agent choosing to. Costs nothing when
   unused, and covers the case where the model ignores get_context. */
server.registerPrompt(
  "recall",
  {
    description: "Load what Brainfeather knows about this project before starting work.",
    argsSchema: { projectId: z.string().optional() },
  },
  async ({ projectId }) => {
    let body: string;
    try {
      body = contextBlock(await client.getContext(projectId));
    } catch (err) {
      body = err instanceof ApiError ? err.message : "Brainfeather is unreachable.";
    }
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `What Brainfeather has on record for this project:\n\n${body}\n\nUse this instead of asking me again. Save new durable facts with save_memory as they come up.`,
          },
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
