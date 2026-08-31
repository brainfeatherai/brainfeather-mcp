# @brainfeather/mcp

Long-term memory for AI coding agents. Facts recorded once, recalled by every client.

Your agent starts every session from zero. You re-explain your stack, your conventions,
the decision you made last week. Brainfeather is the layer that remembers, so it does not
have to ask again.

## Install

Pin the version so clients do not silently roll back to an older cache:

```json
{
  "mcpServers": {
    "brainfeather": {
      "command": "npx",
      "args": ["-y", "@brainfeather/mcp@1.6.1"],
      "env": {
        "BRAINFEATHER_API_KEY": "bf_live_your_key_here"
      }
    }
  }
}
```

Generate a key at **[brainfeather.com/api-keys](https://brainfeather.com/api-keys)**.

Then install host adapters so recall and capture do not depend on the model remembering
to call a tool:

```bash
npx -y @brainfeather/mcp@1.6.1 init
```

That writes fail-open Cursor hooks, a Claude Code plugin, and an auto-discovered
OpenCode plugin under `~/.config/opencode/plugins/`.
Inferred facts still go to the [review queue](https://brainfeather.com/review). They
never enter recall until you approve them.

Config file locations:

| Client | Path |
|---|---|
| Claude Code | `~/.claude/settings.json` |
| Cursor | `~/.cursor/mcp.json` |
| OpenCode | `opencode.json` / `~/.config/opencode/opencode.json` |
| Other | see your client's MCP docs |

### Cursor / Claude Code (stdio)

Use the JSON block above. Cursor also accepts Streamable HTTP:

```json
{
  "mcpServers": {
    "brainfeather": {
      "url": "https://brainfeather.com/mcp",
      "headers": {
        "Authorization": "Bearer bf_live_your_key_here",
        "x-brainfeather-project": "github.com/you/your-repo"
      }
    }
  }
}
```

HTTP MCP has no workspace roots. Set `x-brainfeather-project` or
`BRAINFEATHER_PROJECT_ID`. File hashing stays on the local stdio server.

Local HTTP (same tools as stdio):

```bash
npx -y @brainfeather/mcp@1.6.1 --http --port 8787
```

The credential-bearing local HTTP server is intentionally loopback-only. Use the
hosted HTTPS endpoint for remote clients.

### Claude Code plugin

```bash
claude plugin marketplace add brainfeatherai/brainfeather-mcp
claude plugin install brainfeather@brainfeather-plugins
```

Then run `/brainfeather:onboard` in a repository to import `AGENTS.md`, `CLAUDE.md`,
`.cursorrules`, and `.cursor/rules`.

### OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
      "mcp": {
    "brainfeather": {
      "type": "local",
      "command": ["npx", "-y", "@brainfeather/mcp@1.6.1"],
      "enabled": true,
      "environment": {
        "BRAINFEATHER_API_KEY": "bf_live_your_key_here"
      }
    }
  }
}
```

`init opencode` installs an auto-discovered global plugin. It reads the existing
Brainfeather MCP environment, derives project scope from the active Git repository,
injects recalled context into the system prompt, and queues inferred facts on
`session.idle`.

## Environment

| Variable | Required | Default |
|---|---|---|
| `BRAINFEATHER_API_KEY` | yes | — |
| `BRAINFEATHER_API_URL` | no | `https://brainfeather.com/api/v1` |
| `BRAINFEATHER_PROJECT_ID` | no | resolved from MCP Roots or Git |
| `BRAINFEATHER_BRANCH` | no | current checked-out Git branch |
| `BRAINFEATHER_TASK_ID` | no | no active task |

The key is the only credential. It maps to one account, and revoking it from the
dashboard takes effect on the next request — no redeploy, no shared secret.

Prefer to keep keys out of your editor config? Put them in `~/.brainfeather/config.json`:

```json
{ "apiKey": "bf_live_your_key_here" }
```

Environment variables take precedence.

If your MCP client exposes one filesystem root, Brainfeather derives a stable project ID
from that repository's `origin` remote. Local repositories without a remote receive a
path-hashed ID so unrelated folders with the same name cannot collide. Multi-root sessions
fail closed. If the client advertises Roots but cannot list them, Brainfeather falls back
to the process working directory when that directory is a recognizable project. Clients
with no Roots support still need `BRAINFEATHER_PROJECT_ID`.

Reads automatically include repository defaults plus memories for the checked-out Git
branch. Pass `taskId` to a tool, or set `BRAINFEATHER_TASK_ID`, to include that task's
overlay too. Detached HEAD and non-Git workspaces use repository scope unless
`BRAINFEATHER_BRANCH` is set explicitly.

Only HTTPS API URLs are accepted, except `http://localhost` for local development. If the
config file is readable by other users, startup warns you to run
`chmod 600 ~/.brainfeather/config.json`.

## Tools

| Tool | When the agent uses it |
|---|---|
| `get_context` | Opening a session — loads stack, decisions, conventions |
| `search_memory` | Before choosing a library or pattern |
| `save_memory` | The moment a durable fact is explicitly stated or confirmed |
| `capture_activity` | After inferred stack choices — queues them for dashboard review |
| `onboard_project` | Once, to import AGENTS.md / CLAUDE.md / editor rules |
| `forget_memory` | Something was recorded in error |
| `list_entities` | Which tools and concepts this project involves |
| `traverse_graph` | What else a change to one tool touches |

Host adapters call `get_context` and `capture_activity` without waiting for the model.
The tools remain for explicit lookups, corrections, and clients with no hooks.

`get_context` optionally accepts `query`, `referenceAt`, and `maxTokens` to compile
task-relevant, point-in-time context within a prompt budget. `search_memory` accepts
`referenceAt` for historical truth. `save_memory` can attach validity intervals,
temporal type, confidence, and evidence provenance such as a commit, file, issue, PR, or
deployment. Existing calls need no changes.

`get_context`, `search_memory`, `list_entities`, `traverse_graph`, and
`capture_activity` accept an optional `taskId`; their branch comes from the current Git
checkout. `save_memory` remains repository-scoped by default so a convention recorded on
`main` does not become main-only. Set its `scope` to `branch`, `task`, or `branch-task`
when the fact is an overlay. `forget_memory` uses the same explicit scope vocabulary.
Host recall and inferred capture automatically follow the checked-out branch and configured
task. Session tokens are isolated per repository/branch/task scope.

File evidence is hashed locally before saving; Brainfeather receives the relative path and
SHA-256 digest, never the file contents. Recalled file and commit evidence is checked against
the exact current workspace root and labelled `verified`, `changed`, `missing`, or
`unverifiable`. Verification blocks path traversal, external symlinks, oversized files, and
ambiguous workspace roots. Other provenance types remain `unverifiable` until a trusted local
verifier exists for them.

Read-only resources:

- `brainfeather://context/current` — recalled project memory
- `brainfeather://review/pending` — inferred facts waiting at [brainfeather.com/review](https://brainfeather.com/review)

Prompts: `recall`, `onboard`.

Eight tools, not sixteen. Every tool description sits in the model's context on every
turn, so the set is deliberately small — and each description states *when* to call it,
because the failure mode for a memory server is not a broken tool, it is an agent that
never invokes one.

`capture_activity` is for inferred facts. They wait in the [review queue](https://brainfeather.com/review)
until the user approves them; they never enter recall on their own. `save_memory` remains
the path for facts the user stated or confirmed.

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
- [Review queue](https://brainfeather.com/review) — approve inferred captures
- [Issues](https://github.com/brainfeatherai/brainfeather-mcp/issues)
