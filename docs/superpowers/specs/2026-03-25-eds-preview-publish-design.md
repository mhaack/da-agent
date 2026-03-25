# EDS Preview & Publish — Design Spec

**Date:** 2026-03-25
**Status:** Approved

## Overview

Extend the da-agent with two AI tools that allow the agent to trigger EDS (Edge Delivery Services) preview and publish operations via the AEM Admin API (`admin.hlx.page`).

## Requirements

- `eds_preview` — triggers a preview of a page (calls `/preview` endpoint only)
- `eds_publish` — triggers a full publish of a page (calls `/preview` then `/live` in sequence; aborts if preview returns non-2xx)
- Both tools do **not** require user approval — no `needsApproval` on either tool
- Authentication uses the IMS token already present in the request
- The `ref` is always `main`

---

## New Files

### `src/eds-admin/types.ts`

```ts
export interface EDSOperationResult {
  status: number;
  path?: string;    // webPath returned by the API; absent if request failed before a response was parsed
  url?: string;     // Preview or live URL; present on success
  error?: string;   // Error message; present on failure
}

export interface EDSPublishResult {
  preview: EDSOperationResult;
  live?: EDSOperationResult;  // Absent if preview returned non-2xx (tool exits early)
}

export interface EDSToolError {
  error: string;
  status?: number;
}

export interface EDSAdminClientOptions {
  apiToken: string;   // IMS token — no Cloudflare service binding needed
  timeout?: number;   // Request timeout in ms; defaults to 30000
}

export interface EDSAPIError {
  status: number;
  message: string;
}
```

Tool execute functions return `EDSOperationResult | EDSToolError` (for `eds_preview`) or
`EDSPublishResult | EDSToolError` (for `eds_publish`).

When the live step fails after a successful preview, `eds_publish` returns `EDSToolError` only — the preview result is **not** included. This matches the flat error pattern used by all other tools and keeps the return type unambiguous.

### `src/eds-admin/client.ts`

`EDSAdminClient` class using direct `fetch()` to `https://admin.hlx.page`. No Cloudflare service binding.

Constructor: `constructor(options: EDSAdminClientOptions)` — no `Fetcher` field.

**Timeout:** 30-second default via `AbortController`, configurable via `options.timeout`. When the abort fires, catch the `AbortError` and throw `{ status: 408, message: 'Request timeout' }` — same shape as `DAAPIError` so `isDAAPIError()` catches it.

**Non-2xx responses:** Throw `{ status: response.status, message: errorData.message || response.statusText }` — same `DAAPIError` shape so `isDAAPIError()` works without modification.

**Success responses (2xx):** Parse JSON and return `EDSOperationResult`.

#### Auth headers (both methods)

```
Authorization: Bearer {apiToken}
x-auth-token: {apiToken}
x-content-source-authorization: Bearer {apiToken}
```

#### Path normalisation

Strip `.html` from the end of `path` if present. All other extensions (or no extension) are passed through unchanged.

```ts
const normalised = path.endsWith('.html') ? path.slice(0, -5) : path;
```

#### EDS Admin API URL templates

Both methods use `POST` with an empty body.

```
preview(owner, repo, path):
  POST https://admin.hlx.page/preview/{owner}/{repo}/main{normalised_path}

publishLive(owner, repo, path):
  POST https://admin.hlx.page/live/{owner}/{repo}/main{normalised_path}
```

Where `{normalised_path}` includes the leading `/` (e.g. `/docs/index`).

#### EDS Admin API response shape

```json
// POST /preview/{owner}/{repo}/main{path} → 200 OK
{
  "webPath": "/docs/index",
  "preview": {
    "url": "https://main--repo--owner.hlx.page/docs/index",
    "status": 200
  }
}

// POST /live/{owner}/{repo}/main{path} → 200 OK
{
  "webPath": "/docs/index",
  "live": {
    "url": "https://main--repo--owner.hlx.live/docs/index",
    "status": 200
  }
}
```

Map to `EDSOperationResult`:
- `status`: HTTP response status code
- `path`: `responseBody.webPath`
- `url`: `responseBody.preview.url` (for preview) or `responseBody.live.url` (for live)

---

## Modified Files

### `src/tools/tools.ts`

#### Updated `DAToolsOptions`

```ts
export type DAToolsOptions = {
  pageContext?: PageContext;
  collab?: CollabClient | null;
  edsClient?: EDSAdminClient;
};
```

#### Updated `createDATools` signature and structure

The TypeScript signature **must** change from `client: DAAdminClient` to `client: DAAdminClient | null`. This is required in both `tools.ts` (function definition) and `server.ts` (call site). Without this change, passing a nullable `daClient` from `server.ts` will produce a TypeScript compile error.

```ts
export function createDATools(client: DAAdminClient | null, options?: DAToolsOptions) {
  const opts = options;  // unchanged; used by useCollabForDoc and collab logic below

  const tools: Record<string, ReturnType<typeof tool>> = {};

  // DA tools — only when client is provided
  if (client) {
    tools.da_list_sources = tool({ ... });
    tools.da_get_source = tool({ ... });
    // ... all existing DA tools unchanged
  }

  // EDS tools — only when edsClient is provided
  const edsClient = opts?.edsClient;
  if (edsClient) {
    tools.eds_preview = tool({ ... });
    tools.eds_publish = tool({ ... });
  }

  return tools;
}
```

The `opts` / `useCollabForDoc` declarations remain at the top of the function, before the `if (client)` block, exactly as today — their position is unchanged. When `client` is null, `opts` is assigned but unused, which is harmless.

#### `eds_preview` tool

```ts
eds_preview: tool({
  description:
    'Preview a page on the EDS (Edge Delivery Services) preview environment. '
    + 'Triggers a preview build so changes become visible at the preview URL. '
    + 'Use this after saving content changes to verify them before publishing.',
  inputSchema: z.object({
    org: z.string().describe('Organization name (owner)'),
    repo: z.string().describe('Repository / site name'),
    path: z.string().describe('Page path (e.g. "/docs/index" or "/docs/index.html" — .html will be stripped)'),
  }),

  execute: async ({ org, repo, path }) => {
    try {
      return await edsClient.preview(org, repo, path);
    } catch (e) {
      if (isDAAPIError(e)) return { error: e.message, status: e.status };
      return { error: String(e) };
    }
  },
})
```

#### `eds_publish` tool

```ts
eds_publish: tool({
  description:
    'Publish a page to the EDS (Edge Delivery Services) live environment. '
    + 'First triggers a preview build, then promotes the page to live. '
    + 'If preview returns an error, publishing is aborted. '
    + 'Use this to make content publicly available.',
  inputSchema: z.object({
    org: z.string().describe('Organization name (owner)'),
    repo: z.string().describe('Repository / site name'),
    path: z.string().describe('Page path (e.g. "/docs/index" or "/docs/index.html" — .html will be stripped)'),
  }),

  execute: async ({ org, repo, path }) => {
    let preview: EDSOperationResult;
    try {
      preview = await edsClient.preview(org, repo, path);
    } catch (e) {
      // Preview failed (non-2xx or timeout) — abort, do not call live
      if (isDAAPIError(e)) return { error: e.message, status: e.status };
      return { error: String(e) };
    }
    try {
      const live = await edsClient.publishLive(org, repo, path);
      return { preview, live };
    } catch (e) {
      if (isDAAPIError(e)) return { error: e.message, status: e.status };
      return { error: String(e) };
    }
  },
})
```

The abort guarantee is enforced by the separate try/catch blocks: if `preview()` throws (any non-2xx HTTP or timeout), the outer catch fires and `publishLive()` is never reached.

#### LLM input values

`org` and `repo` are free-form LLM inputs, consistent with existing DA tools. The system prompt instructs the model to use `pageContext.org` → `org` and `pageContext.site` → `repo`.

### `src/server.ts`

Construct `EDSAdminClient` whenever `imsToken` is present, independently of `DAADMIN`:

```ts
const edsClient = imsToken
  ? new EDSAdminClient({ apiToken: imsToken })
  : undefined;
```

Replace the conditional `createDATools` call with an unconditional one:

```ts
// Before:
const daTools = daClient
  ? createDATools(daClient, { pageContext, collab })
  : {};

// After:
const daTools = createDATools(daClient, {
  pageContext: pageContext ?? undefined,
  collab: collab ?? undefined,
  edsClient,
});
```

`resolveApprovals(messages, daTools)` receives the combined map unchanged — EDS tools are part of the same `daTools` object.

`loadSkills` remains gated on `daClient && pageContext`. When `DAADMIN` is absent but `imsToken` exists, skills are not loaded — intentional, since skills live in the DA repository.

#### When IMS token is absent

Both `daClient` and `edsClient` are undefined and no tools are registered. Model responds in prose only.

---

## Error Handling Summary

| Scenario | Client behaviour | Caught by | Tool returns |
|---|---|---|---|
| Non-2xx HTTP | throws `{ status, message }` | `isDAAPIError()` | `{ error, status }` |
| 30s timeout | throws `{ status: 408, message: 'Request timeout' }` | `isDAAPIError()` | `{ error: 'Request timeout', status: 408 }` |
| Network error | throws `Error` | String(e) fallback | `{ error: '...' }` |
| Preview non-2xx in publish | throws → outer catch fires | `isDAAPIError()` | `{ error, status }` (live never called) |
| Live non-2xx in publish | throws → inner catch fires | `isDAAPIError()` | `{ error, status }` — `EDSToolError` only; do **not** include the `preview` result in this return value |

---

## System Prompt

No changes required. Existing instruction to use `pageContext` values for tool parameters applies to EDS tools via tool descriptions and model context.
