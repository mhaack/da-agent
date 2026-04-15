# DA Agent: Expected Markdown Output Types

This document catalogs all markdown/structured output types the agent can reasonably produce, covering ~95% of use cases. For each type, the originating prompt or code path is referenced.

---

## 1. Plain Prose Confirmation

**Description:** A short, plain-text sentence confirming an action was taken. No markdown formatting.

**Example:**
```
The page has been updated with the new hero section.
```

**Source:** `src/server.ts:869-886` — Edit view rules explicitly instruct:
> "After updating, give a brief confirmation in plain prose."

**When triggered:** Any `content_update`, `content_create`, `content_delete`, `content_move`, or `content_copy` operation completes.

---

## 2. Rich List (`:::list`)

**Description:** A styled bullet list using the custom `:::list` fence block. This is the general-purpose list format; file/directory listings and version history are common variations of the same block.

**Example — generic list:**
```
:::list
- Item one
- Item two
- Item three
:::
```

**Example — file / directory listing** (`content_list` tool, `src/tools/tools.ts`):
```
:::list
- `/blog/index` (page)
- `/blog/2024/` (folder)
- `/blog/2023/` (folder)
:::
```

**Example — version history** (`content_version_list` tool, `src/tools/tools.ts`):
```
:::list
- **v3** – "Pre-launch freeze" (2024-03-10)
- **v2** – "Added hero image" (2024-02-28)
- **v1** – Initial version (2024-02-15)
:::
```

**Source:** `src/server.ts:752-797` — Rich response formatting section describes `:::list` as a block for visual styling of lists.

**When triggered:** Summarizing multiple pages, files, results, or options — e.g., "What pages are in this site?", "What's in this folder?", "Show me the version history."

---

## 3. Checklist (`:::checklist`)

**Description:** A visual checklist with checked/unchecked items using `[x]` and `[ ]` syntax.

**Example:**
```
:::checklist
- [x] Homepage updated
- [x] Blog index published
- [ ] Contact page missing metadata
:::
```

**Source:** `src/server.ts:752-797` — Rich response formatting section describes `:::checklist` with `[x]` / `[ ]` markers.

**When triggered:** Reporting results of bulk operations, audit findings, multi-step task completion status, or publishing summaries.

---

## 4. Info Alert (`:::alert-info`)

**Description:** A blue informational callout box.

**Example:**
```
:::alert-info
This page is currently only in preview and has not been published to the live site.
:::
```

**Source:** `src/server.ts:752-797` — Rich response formatting section describes `:::alert-info` as a colored callout.

**When triggered:** Providing contextual information, noting current state, or giving tips without requiring user action.

---

## 5. Warning Alert (`:::alert-warning`)

**Description:** A yellow/orange warning callout box.

**Example:**
```
:::alert-warning
This page references a fragment that could not be found. The published output may be incomplete.
:::
```

**Source:** `src/server.ts:752-797` — Rich response formatting section describes `:::alert-warning`.

**When triggered:** Potential issues detected (missing references, unusual content structure, partial failures), or before performing a destructive action.

---

## 6. Error Alert (`:::alert-error`)

**Description:** A red error callout box.

**Example:**
```
:::alert-error
The publish operation failed for 3 pages. Check the paths and try again.
:::
```

**Source:** `src/server.ts:752-797` — Rich response formatting section describes `:::alert-error`.

**When triggered:** Tool failures, invalid inputs, API errors, or failed bulk operations.

---

## 7. Toggle List (`:::toggle-list`)

**Description:** Collapsible/expandable sections. Uses `>` for the section title and indented content below.

**Example:**
```
:::toggle-list
> Homepage (`/index`)
  - Title: Welcome to Acme
  - Last modified: 2024-03-01
  - Status: Published

> Blog Index (`/blog/index`)
  - Title: Blog
  - Last modified: 2024-02-15
  - Status: Preview only
:::
```

**Source:** `src/server.ts:752-797` — Rich response formatting section describes `:::toggle-list` with `> Section title` and indented details.

**When triggered:** Listing pages with details, showing version history, grouping results by category, or summarizing multiple content items.

---

## 8. Skill Suggestion Block

**Description:** A structured suggestion block the agent automatically produces when it detects repeated user intent patterns. Contains a machine-readable preamble followed by a plain-prose message.

**Example:**
```
[SKILL_SUGGESTION]
SKILL_ID: translate-page-to-french
---SKILL_CONTENT_START---
# Translate Page to French

When asked to translate a page to French:
1. Read the current page content
2. Translate all text to French
3. Update the page
4. Preview the page
---SKILL_CONTENT_END---

I noticed you've asked to translate pages to French multiple times. I've prepared a skill called "translate-page-to-french" — click **Create Skill** to save it.
```

**Source:** `src/server.ts:914-933` — Skill suggestion instructions with exact `[SKILL_SUGGESTION]` block format, `SKILL_ID`, `---SKILL_CONTENT_START---` / `---SKILL_CONTENT_END---` delimiters, and a natural language follow-up.

**Also:** `src/user-message-pattern.ts` — Jaccard similarity detection (threshold 0.42) across at least 3 messages to trigger the suggestion.

**When triggered:** Automatically when 3+ user messages match a repeated pattern (e.g., repeated translation, repeated publishing, repeated formatting tasks).

---

## 9. Structured Results Table (Markdown Table)

**Description:** A standard markdown table summarizing results from multi-page operations.

**Example:**
```
| Page | Status | URL |
|------|--------|-----|
| `/index` | Published | https://live.example.com/index |
| `/blog` | Published | https://live.example.com/blog |
| `/contact` | Failed | — |
```

**Source:** `src/tools/tools.ts:579-596` — `BulkAemCanvasDialogOutputSchema` includes `results[]` with `path`, `ok`, `status`, `message`, `publishedUrl`. The agent is expected to surface these results clearly.

**When triggered:** After `da_bulk_publish`, `da_bulk_preview`, or `da_bulk_delete` with multiple pages.

---

## 10. Published URL List

**Description:** A plain list of live URLs returned after a publish operation.

**Example:**
```
The following pages are now live:

- https://main--mysite--myorg.hlx.live/index
- https://main--mysite--myorg.hlx.live/blog
- https://main--mysite--myorg.hlx.live/contact
```

**Source:** `src/tools/tools.ts:593` — `publishedUrls` field in `BulkAemCanvasDialogOutputSchema`; `src/server.ts:752-797` publish workflow description.

**When triggered:** After any single or bulk publish operation that returns live URLs.

---

## 11. Page Context Summary

**Description:** A brief prose summary of the current page context the agent is operating in, sometimes shown at the start of a response.

**Example:**
```
I'm working on `/blog/2024/my-post` in the **myorg/mysite** repository (currently in edit view).
```

**Source:** `src/server.ts:856-868` — Page context section injected into system prompt with `org`, `site`, `path`, and `view`.

**When triggered:** When the agent restates context for clarity, or when asked "what page am I on?" / "what are you looking at?"

---

## 12. Project Memory Content (Markdown)

**Description:** Structured markdown the agent writes to `.da/agent/memory.md` to record site knowledge. Also shown inline when the agent references what it remembers.

**Example:**
```
## Site Structure
- Homepage: `/index`
- Blog index: `/blog/index`
- Blog posts: `/blog/{year}/{slug}`

## Templates
- Standard page: `<main>` with hero block + content blocks
- Blog post: `<main>` with `post-header` block + text sections

## Conventions
- All images stored under `/media/`
- Navigation defined in `/nav`
```

**Source:** `src/server.ts:891-910` — Memory instructions specify the agent MUST write full updated markdown including site structure, pages, content understanding, purpose, URL patterns, and templates.

**When triggered:** After the agent reads pages, lists directories, discovers patterns, or learns anything structural about the site.

---

## 13. Skill Content (Markdown)

**Description:** Markdown content written to a skill file when the user asks to create or update a skill.

**Example:**
```
# Publish Blog Post

When asked to publish a blog post:
1. Read the post at the specified path
2. Check that it has a `post-header` block
3. Preview: call content_preview
4. Publish: call content_publish
5. Confirm the live URL to the user
```

**Source:** `src/tools/tools.ts:459-482` — `da_create_skill` tool accepts `content` as full markdown. `src/server.ts:693-701` — Skills listed in system prompt; first heading extracted as title.

**When triggered:** User asks to "save this as a skill", "create a skill for this", or agent auto-suggests via skill suggestion block.

---

## 14. Agent Preset Description (JSON / Prose)

**Description:** When the agent creates an agent preset, it writes a JSON file and confirms in prose.

**Example (confirmation prose):**
```
The "Blog Editor" agent has been created. It will automatically load the `publish-blog-post` and `translate-content` skills and is configured to focus on blog content workflows.
```

**Source:** `src/tools/tools.ts` — `da_create_agent` tool; `src/agents/loader.ts` — `AgentPreset` interface with `name`, `description`, `systemPrompt`, `skills`, `mcpServers`.

**When triggered:** User asks to "create an agent", "set up an agent preset", or "save this configuration as an agent."

---

## 15. Error / Failure Message (Prose)

**Description:** A plain-text explanation of why something could not be done.

**Example:**
```
The page at `/blog/old-post` could not be deleted because it is still published on the live site. Unpublish it first, then delete.
```

**Source:** `src/server.ts:733-750` — Base instructions say to describe RESULTS plainly. Tool error results surface as prose explanations. `:::alert-error` may also be used (see §6).

**When triggered:** Any tool returns an error, or the requested operation is not possible given current state.

---

## 16. Disambiguation / Clarifying Question

**Description:** A short prose question asking the user to clarify intent before acting.

**Example:**
```
Did you want me to update the **hero block** text, or the **metadata title** field?
```

**Source:** `src/server.ts:869-886` — Edit view rules instruct the agent to "ALWAYS call get content tool before making changes" and never assume current state, implying the agent may ask for clarification when the request is ambiguous.

**When triggered:** Request is ambiguous (multiple possible targets, unclear scope, missing required information).

---

## Summary Table

| Output Type | Custom Fence | Markdown | Prose | Source (key file:lines) |
|---|---|---|---|---|
| Plain prose confirmation | — | — | Yes | `server.ts:869-886` |
| Rich list (incl. file listings & version history) | `:::list` | — | — | `server.ts:752-797`, `tools.ts` (content_list, content_version_list) |
| Checklist | `:::checklist` | — | — | `server.ts:752-797` |
| Info alert | `:::alert-info` | — | — | `server.ts:752-797` |
| Warning alert | `:::alert-warning` | — | — | `server.ts:752-797` |
| Error alert | `:::alert-error` | — | — | `server.ts:752-797` |
| Toggle list | `:::toggle-list` | — | — | `server.ts:752-797` |
| Skill suggestion block | — | `[SKILL_SUGGESTION]` | Yes | `server.ts:914-933`, `user-message-pattern.ts` |
| Bulk results table | — | Table | — | `tools.ts:579-596` |
| Published URL list | — | List | Yes | `tools.ts:593` |
| Page context summary | — | — | Yes | `server.ts:856-868` |
| Project memory (markdown) | — | Full md | — | `server.ts:891-910` |
| Skill content (markdown) | — | Full md | — | `tools.ts:459-482` |
| Agent preset confirmation | — | — | Yes | `tools.ts` (da_create_agent) |
| Error / failure message | `:::alert-error` / prose | — | Yes | `server.ts:733-750` |
| Disambiguating question | — | — | Yes | `server.ts:869-886` |
