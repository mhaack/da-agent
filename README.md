# DA Agent

[![66% Vibe_Coded](https://img.shields.io/badge/66%25-Vibe_Coded-ff69b4?style=for-the-badge&logo=claude&logoColor=white)](https://github.com/ai-ecoverse/vibe-coded-badge-action)

An AI assistant Cloudflare Worker for the [Document Authoring (DA)](https://da.live) platform. It exposes a streaming chat API backed by Claude on Amazon Bedrock and integrates directly with the DA Admin API to read, create, update, and manage content.

## Features

- **Streaming chat** — Server-sent event stream via the Vercel AI SDK (`POST /chat`)
- **DA tools** — Full set of DA Admin API operations available as LLM tools: list, get, create, update, delete, copy, move sources; versioning; media upload; fragment lookup
- **Human-in-the-loop approval** — Destructive tools (create, update, delete, move) require explicit user confirmation before executing
- **Collab integration** — When the user is in edit view, reads and writes go through the live Y.js collaborative session (`da-collab` service binding) so changes appear in real time
- **Page context awareness** — The current org, site, path, and view are injected into the system prompt and used as defaults for all tool calls
- **Custom skills** — Customers define reusable workflow instructions as markdown files stored at `/.da/skills/` in their DA repository; the agent loads and injects them automatically on each request

## Architecture

```
Client (DA authoring UI or curl/scripts)
  │  POST /chat  (messages, pageContext, imsToken)
  ▼
da-agent (Cloudflare Worker)
  ├── Vercel AI SDK streamText → Amazon Bedrock (claude-sonnet-4-6)
  ├── DA tools → DAADMIN service binding → da-admin Worker
  ├── Collab client → DACOLLAB service binding → da-collab Worker
  └── Skills loader → DAADMIN (reads /.da/skills/*.md)
```

## Project structure

```
src/
  server.ts            # Worker entry point, chat handler, system prompt, skills loader
  collab-client.ts     # Y.js collab session client
  da-admin/
    client.ts          # DA Admin API client (wraps service binding calls)
    types.ts           # TypeScript types for DA Admin API
  tools/
    tools.ts           # Vercel AI SDK tool definitions wrapping DAAdminClient
    utils.ts           # Shared utilities (path helpers)
samples/
  skills/
    translate-content.md  # Example skill file
test/
  server.test.ts       # Vitest tests
```

## Local development

### Prerequisites

- Node.js 22+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI
- AWS credentials with Bedrock access (for the Claude model)
- Local instances of `da-admin` and `da-collab` Workers running

### Setup

```bash
npm install
```

Copy `.dev.vars.example` to `.dev.vars` and fill in your credentials:

```
AWS_BEARER_TOKEN_BEDROCK=<your-aws-bearer-token>
```

Start the dev server (connects to local `da-admin` and `da-collab` via service bindings):

```bash
npm run dev
```

The worker listens on **`http://127.0.0.1:4002`** (see `[dev] port` in `wrangler.toml`).

### Invoking the agent from the command line

There is no separate DA CLI for chat; you call **`POST /chat`** like the browser does. Use a **stage** Adobe IMS access token in `IMS_TOKEN` (same tier as localhost DA). The JSON field `imsToken` is what da-agent uses for DA Admin and EDS.

```bash
export IMS_TOKEN='eyJ...'   # stage IMS access token (JWT string)

curl -sN -X POST 'http://127.0.0.1:4002/chat' \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --arg tok "$IMS_TOKEN" \
    '{
      imsToken: $tok,
      pageContext: { org: "aemsites", site: "da-block-collection", path: "/index.html", view: "browse" },
      messages: [
        { role: "user", content: "Hello — summarize what DA tools I can use on this site." }
      ]
    }')"
```

### Chat API

```
POST /chat
Content-Type: application/json

{
  "messages": [...],
  "pageContext": {
    "org": "my-org",
    "site": "my-site",
    "path": "/docs/my-page",
    "view": "edit"
  },
  "imsToken": "<ims-access-token-jwt>"
}
```

`imsToken` is read from the JSON body (the browser chat client sends the same value). It is not taken from an `Authorization` header on `/chat`.

Returns a streaming UI message response (Vercel AI SDK format).

```
HEAD /chat   →  200 OK  (health check / CORS preflight)
```

## Custom skills

Skills let customers extend the agent with site-specific workflow instructions without any code changes.

Create markdown files at `/.da/skills/<skill-name>.md` in your DA repository. The agent fetches all `.md` files from that folder on every request and injects their contents into the system prompt.

### Skill format

```markdown
---
name: My Skill
description: What this skill does and when to use it.
triggers:
  - keyword or phrase that activates this skill
---

# My Skill

Instructions for the agent...

## Steps

1. Step one
2. Step two
```

See [`samples/skills/translate-content.md`](samples/skills/translate-content.md) for a full example that translates the current page into another language and saves it under a language-specific path (e.g. `/de/`, `/fr/`).

## Tools

| Tool | Description | Requires approval |
|---|---|---|
| `da_list_sources` | List files and folders in a repository path | No |
| `da_get_source` | Read a file's content | No |
| `da_create_source` | Create a new file | Yes |
| `da_update_source` | Update an existing file | Yes |
| `da_delete_source` | Delete a file | Yes |
| `da_copy_content` | Copy a file to a new path | No |
| `da_move_content` | Move a file to a new path | Yes |
| `da_create_version` | Snapshot the current state of a file | No |
| `da_get_versions` | Get version history for a file | No |
| `da_lookup_media` | Look up a media asset | No |
| `da_lookup_fragment` | Look up a content fragment | No |
| `da_upload_media` | Upload a base64-encoded image or file | No |

## Deployment

Deployments are managed automatically via [semantic-release](https://semantic-release.gitbook.io/) on every push to `main`.

The pipeline (`main.yaml`) runs three jobs:

| Job | Trigger | What it does |
|---|---|---|
| **Test** | All branches | `npm run lint` + `npm test` |
| **Test Deploy** | Non-main branches | Deploys to `da-agent-ci` (staging services) + semantic-release dry run |
| **Release** | `main` only | Semantic-release: bumps version, updates `CHANGELOG.md`, deploys to CI then production, creates GitHub release |

### Manual deploy

```bash
npm run deploy
```

### Required GitHub secrets

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Worker deploy permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

### Environments

| Wrangler env | Worker name | Services |
|---|---|---|
| `dev` (local) | `da-agent-local` | `da-admin-local`, `da-collab-local` |
| `ci` | `da-agent-ci` | `da-admin-stage`, `da-collab-stage` |
| `production` | `da-agent` | `da-admin`, `da-collab` |

## License

Apache-2.0
