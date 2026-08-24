# da-agent — Project Memory

## Incremental content editing: `content_replace` tool (added 2026-05)

**Why:** Editing a live doc previously meant rewriting the whole AEM HTML body via
`content_replace_doc` → `CollabClient.applyContent` (clears the whole prosemirror fragment, re-runs
`aem2doc`). The dominant cost is the LLM regenerating the entire document as output tokens for even a
one-line edit; it also wiped `daMetadata`, disrupted other users' cursors/undo, and forced a full
da-live re-render. `content_replace` does an inline splice of a contiguous range of top-level nodes
so the agent emits only the changed fragment.

### Design decisions
- **Granularity:** top-level node range (whole blocks/paragraphs). No intra-paragraph character
  ranges — ProseMirror positions aren't LLM-derivable from HTML, and a paragraph is already one node.
- **Addressing = encoded yjs *relative positions*** (NOT raw integer indices). `content_read`
  surfaces a per-block opaque base64 `locator`; the agent copies it back. Relative positions survive
  concurrent edits (raw indices silently shift and corrupt). Verified: a locator captured before a
  concurrent insert still resolves to the right block.
- **Scope:** fully contained in da-agent. Reuses `aem2doc`/`doc2aem` from `@da-tools/da-parser` via a
  `<body><main><div>…</div></main></body>` wrapper into a throwaway `Y.Doc` — no parser changes.
- **Collab-only:** locators only exist for the live collab doc. Non-collab/whole-page edits still use
  `content_replace_doc`.

### Implementation (key files)
- `src/collab-client.ts` — on `CollabClient`:
  - `readBlocks()` → `[{ index, locator, html }]`; filters out `horizontal_rule` separators and empty
    structural paragraphs. `locator` = base64 of `Y.encodeRelativePosition(createRelativePositionFromTypeIndex(frag, i))`.
  - `replaceRange(startLocator, endLocator|null, html)` → parses+validates first, then in one
    `transact`: resolve locators to indices (`createAbsolutePositionFromRelativePosition`),
    `frag.delete(start, count)` + `frag.insert(start, clones.map(n => n.clone()))`. Leaves
    `daMetadata` untouched.
  - private `serializeNode` (clone node → temp doc → `doc2aem` → strip shell + section `<div>`) and
    `parseFragment` (wrap → `aem2doc` → `toArray()`).
  - base64 via `btoa`/`atob` helpers (Workers-safe; `nodejs_compat` is on but these avoid `Buffer`).
- `src/tools/tools.ts` — `content_read` collab path now returns `blocks`; new `content_replace` tool
  (`needsApproval: () => true`), persists full HTML via `updateSource(..., { initiator: 'collab' })`,
  and **does NOT disconnect** (so batched/successive edits in a turn reuse the session + locators).
- `src/prompt-builder.ts` (NOT server.ts — the prompt was extracted here) — edit-view rules steer the
  agent to prefer `content_replace` for targeted edits, `content_replace_doc` for whole-page rewrites.

### Gotchas / known limits (found via a trace harness)
- **Verification is a structural parse guard, not an HTML validator.** It rejects unparseable, empty/
  whitespace-only (explicit guard added), and stale-locator cases before mutating. It does NOT catch
  malformed-but-coercible HTML: the HTML parser is lenient and turns junk (e.g. `<<<junk`) into a text
  `<p>`, which passes and gets applied. The `needsApproval` human gate is the semantic backstop.
- **Disconnect lifecycle:** `content_replace` never calls `disconnect()`. Session teardown happens at
  the turn level — `streamText` `onFinish`/`onError` (`server.ts:~270-276`), the pending-approval path
  (`server.ts:~195`), or the chat-context setup timeout. Because `content_replace` requires approval,
  the session drops at the approval boundary and a fresh `Y.Doc` is created on approval — locators
  cross a reconnect. Relative positions *should* survive (Durable Object persists stable item IDs) but
  this reconnect case was NOT verified live (only concurrent-insert was). Verify in da-collab.

### How to verify
- vitest (`npx vitest run`), node env, `fs` available. Drive real tools by `createDATools(stubClient,
  { pageContext: {view:'edit'}, collab, org, repo })`, inject a real `Y.Doc` into a `CollabClient`
  (`(collab as any).ydoc = ydoc; collab.isConnected = true`), then call `tools.content_read.execute(args, ctx)`.
- Manual e2e: in da-collab + da-live, `content_read` then `content_replace`; confirm only the edited
  block re-renders, another user's cursor survives, and da-collab's debounced `doc2aem` PUT fires.

## Live edits not appearing until refresh = collab backend mismatch (added 2026-05)

**Symptom:** after an approved `content_replace`, the edit was in da-admin (a manual page refresh
rendered it) but did NOT appear live in da-live, and the agent's *own* next `content_read` returned
stale content.

**Actual root cause: da-agent and the browser were connected to *different* da-collab backends** (a
different `DACOLLAB` websocket endpoint) while pointing at the *same* da-admin DB. So edits persisted
to the shared da-admin (→ visible on refresh) but the live Yjs broadcast never crossed, because the
two clients were in rooms on different collab servers. The agent's next turn re-synced from da-agent's
own (correct, updated) backend — but if you were comparing against the browser's view, they simply
weren't the same room.

**Fix is configuration, not code:** make da-agent's `DACOLLAB` binding and da-live's collab websocket
point at the *same* da-collab instance. There is no teardown/flush race to fix — `content_replace`
mutates the live `Y.Doc` (y-websocket broadcasts it) and awaits the `updateSource` PUT, which already
keeps the request context alive long enough for the broadcast. A `flush()`-ack barrier was prototyped
and **reverted** once the mismatch was understood; don't re-add it unless a *same-backend* drop is
actually observed.

**How to tell next time:** if a refresh shows the change but live doesn't, and the agent's re-read
disagrees with the browser, suspect mismatched collab backends before suspecting Yjs delivery. Quick
check: confirm both sides resolve to the same da-collab origin/room URL.

## Local dev gotcha: wrangler version skew (added 2026-05)
da-agent, da-collab, da-admin run as separate `wrangler dev` processes wired by cross-process service
bindings (the dev registry). That IPC channel is **version-coupled to the bundled workerd**: if the
wrangler versions are far apart (seen with da-agent 4.68 vs da-collab/da-admin 4.92/4.93), bindings
still report `[connected]` but every call across them throws `Error: Network connection lost.` (incl.
the collab WebSocket). A small skew (4.92↔4.93) is fine; a large one is not. Fix = align versions
(bumped da-agent to wrangler ^4.95). Recurs whenever one repo bumps wrangler significantly; tell is
`[connected]` bindings that nonetheless throw "Network connection lost."

## Repo notes
- Pre-existing unrelated type error at `src/server.ts:290` (`AttributeValue` / `undefined`) — present
  before this work; not ours.
- Reference doc: `docs/incremental-content-updates.md` (format trace, read/write paths, code seams).
