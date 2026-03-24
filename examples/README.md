# MCP Discovery — Example Repository Layout

This directory shows the author-facing layout for **repo-scoped MCP server discovery** in DA.

## Directory structure

```
your-site-repo/
  mcp-servers/
    acme-tools/          # serverId = "acme-tools"
      mcp.json           # stdio server: runs a local Node process
    analytics-api/       # serverId = "analytics-api"
      mcp.json           # remote server: SSE connection to a URL
```

Each subdirectory under `mcp-servers/` is one MCP server. The directory name **is** the `serverId`, and it must match `^[a-zA-Z0-9_-]+$` (letters, digits, hyphens, underscores — no spaces).

## `mcp.json` — stdio example

A stdio server runs a local command. The `mcp.json` contains the same shape as a single value in a standard `mcpServers` config:

```json
{
  "command": "node",
  "args": ["./dist/server.js"]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `command` | yes | Executable to run (e.g. `node`, `python3`, `npx`) |
| `args` | no | Array of command-line arguments |
| `env` | no | Extra environment variables (`Record<string, string>`) |
| `cwd` | no | Working directory. **Default:** `mcp-servers/<serverId>/` (so relative paths in `args` work out of the box) |

## `mcp.json` — remote (SSE / HTTP) example

A remote server connects over the network:

```json
{
  "type": "sse",
  "url": "https://analytics.example.com/mcp"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | `"sse"` or `"http"` |
| `url` | yes | Absolute URL to the MCP endpoint. Relative URLs are resolved against the connected site origin if configured; otherwise they produce a warning and are skipped. |
| `headers` | no | Extra HTTP headers (`Record<string, string>`) |

## What happens at runtime

1. **Discovery** — The DA admin service scans `mcp-servers/` for subdirectories, reads each `mcp.json`, validates the config, and writes a normalized cache to `.da/discovered-mcp.json` in the repository.

2. **Merge** — The DA agent loads the cache and merges it with any platform/system MCP servers. System servers always win on name collisions — if your repo has a server called `playwright` and the platform already defines one, the platform version is kept and a warning is emitted.

3. **Tool naming** — Tools from a repo server named `acme-tools` appear as `mcp__acme-tools__<toolName>`. Skills, sub-agents, and prompts can reference them by this pattern.

## Refreshing

Trigger a rescan with a GET request to the admin API:

```
GET /mcp-discovery/{org}/{site}
```

This is typically called after cloning, pulling, or changing `mcp-servers/` content.

## Rules and limits

- `mcp.json` must be valid JSON and under 64 KiB.
- Directories without a valid `mcp.json` are skipped with a warning.
- Server IDs that collide with platform-reserved names (e.g. `playwright`, `catalyst_ui`) are skipped with a warning.
- Only directories directly under `mcp-servers/` are scanned — nested subdirectories and loose files at the root are ignored.
