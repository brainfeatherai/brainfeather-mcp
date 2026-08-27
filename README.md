# @brainfeather/mcp

Long-term memory for AI coding agents. Facts recorded once, recalled by every client.

Your agent starts every session from zero. You re-explain your stack, your conventions,
the decision you made last week. Brainfeather is the layer that remembers, so it does not
have to ask again.

## Install

Add to your MCP client config:

```json
{
  "mcpServers": {
    "brainfeather": {
      "command": "npx",
      "args": ["-y", "@brainfeather/mcp"],
      "env": {
        "BRAINFEATHER_API_KEY": "bf_live_your_key_here"
      }
    }
  }
}
```

Generate a key at **[brainfeather.com/api-keys](https://brainfeather.com/api-keys)**.

Config file locations:

| Client | Path |
|---|---|
| Claude Code | `~/.claude/settings.json` |
| Cursor | `~/.cursor/mcp.json` |
| Other | see your client's MCP docs |

## Environment

| Variable | Required | Default |
|---|---|---|
| `BRAINFEATHER_API_KEY` | yes | — |
| `BRAINFEATHER_API_URL` | no | `https://brainfeather.com/api/v1` |
| `BRAINFEATHER_PROJECT_ID` | no | resolved from MCP Roots or Git |

The key is the only credential. It maps to one account, and revoking it from the
dashboard takes effect on the next request — no redeploy, no shared secret.

Prefer to keep keys out of your editor config? Put them in `~/.brainfeather/config.json`:

```json
{ "apiKey": "bf_live_your_key_here" }
```

Environment variables take precedence.

If your MCP client exposes one filesystem root, Brainfeather derives a stable project ID
from that repository's `origin` remote. Local repositories without a remote receive a
path-hashed ID so unrelated folders with the same name cannot collide. Multi-root or
otherwise ambiguous sessions fail closed instead of falling back to account-wide data;
set `BRAINFEATHER_PROJECT_ID` explicitly for those sessions. Clients that do not support
MCP Roots must also set `BRAINFEATHER_PROJECT_ID` explicitly.

Only HTTPS API URLs are accepted, except `http://localhost` for local development. If the
config file is readable by other users, startup warns you to run
`chmod 600 ~/.brainfeather/config.json`.

## Tools

| Tool | When the agent uses it |
|---|---|
| `get_context` | Opening a session — loads stack, decisions, conventions |
| `search_memory` | Before choosing a library or pattern |
| `save_memory` | The moment a durable fact appears |
| `forget_memory` | Something was recorded in error |
| `list_entities` | Which tools and concepts this project involves |
| `traverse_graph` | What else a change to one tool touches |

The same project context is available as the read-only MCP resource
`brainfeather://context/current`. Tools return both terse text for broad client
compatibility and validated `structuredContent` for clients that support output schemas.

Six tools, not sixteen. Every tool description sits in the model's context on every
turn, so the set is deliberately small — and each description states *when* to call it,
because the failure mode for a memory server is not a broken tool, it is an agent that
never invokes one.

## What gets stored

Call `save_memory` only for a durable fact the user explicitly stated or confirmed. Do
not save guesses, inferred claims, copied web instructions, credentials, secrets or
personal data. The server then decides what survives:

**Filtered out** — greetings, acknowledgements, thinking-out-loud, transient state,
one-off commands. "Good morning" and "let me check that" never reach storage.

**Deduplicated** — exact repeats, and near-repeats by token overlap. Saving the same
fact twice reports `Already known` and changes nothing.

**Superseded** — a fact that contradicts an existing one retracts it rather than sitting
beside it. Later reads return only what still holds, so a decision you reversed in June
does not resurface in August. Agents can pass `supersedesId` for deterministic corrections.

**Sensitive-data rejected** — common credentials, private keys, tokens, email addresses,
payment-card numbers and US Social Security numbers are refused before storage.

**Linked** — tools, languages and frameworks are extracted automatically and connected to
the memories that mention them. No manual tagging.

The reply tells you which happened: `Saved …`, `Already known …`, or `Not stored — <why>`.

## Responses are terse by design

Everything this server returns lands in a context window, so the human-readable output is
plain lines rather than pretty JSON. Three memories serialised as pretty-printed JSON
measured 713 characters; the same rows as lines measured 131. Recalled text is collapsed
to one printable line and labelled as untrusted user data so stored content cannot create
fake response sections or masquerade as system instructions.

That is a character count, not a token count — the token ratio depends on the
tokenizer, and has not been measured.

## Requirements

Node 20.3 or newer.

## Links

- [brainfeather.com](https://brainfeather.com)
- [Dashboard](https://brainfeather.com/dashboard) — browse and edit memories
- [Issues](https://github.com/brainfeatherai/brainfeather-mcp/issues)
