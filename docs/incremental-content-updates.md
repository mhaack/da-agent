# Incremental Content Updates — Format Trace & Implementation Notes

> **Status:** Investigation / design input. No code has been changed.
> **Goal:** Let the content-update tool make *incremental* edits to a document (e.g. replace a
> single paragraph) instead of re-writing the full HTML body on every change.
>
> This document traces every format a document passes through on read and on write, identifies
> the exact code seams, and recommends where to implement incremental updates. It is written to
> be self-contained: an implementing agent should be able to start from here.

---

## 1. Repos involved

| Repo | Role |
|---|---|
| **da-agent** | The AI agent worker. Hosts the content tools (`src/tools/tools.ts`) and the collab client (`src/collab-client.ts`). This is where the change will most likely land. |
| **da-tools/da-parser** (`@da-tools/da-parser`) | Shared format-conversion library. Exposes `aem2doc`, `doc2aem`, `getSchema`, and re-exports `y-prosemirror` helpers. Used by **both** da-collab and da-live. |
| **da-collab** | Cloudflare Worker hosting the Yjs collaboration server (Durable Objects). Loads docs from da-admin into a `Y.Doc`, persists changes back. |
| **da-admin** | Source-of-truth storage (S3). Accessed by da-agent and da-collab via Cloudflare service bindings. Stores documents as **AEM/EDS HTML**. |
| **da-live** | The browser editor (ProseMirror + y-prosemirror). The "other" client on the same collab session. |

All repos are siblings under the workspace root (e.g. `../da-tools`, `../da-collab` relative to da-agent).

---

## 2. The formats

| Format | Description |
|---|---|
| **AEM / EDS HTML** | The persisted source-of-truth string and the format the agent reads/writes. Shape: `<body><header></header><main> …sections separated by <hr>… </main><footer></footer></body>`. EDS blocks are `<div class="block-name">` wrappers (each row a child `<div>`, each column a nested `<div>`). Stored in S3 by da-admin. |
| **HAST tree** | Intermediate virtual DOM from parsing HTML. `hast-util-from-html` in Cloudflare Workers (no DOM); native `DOMParser` in the browser. |
| **ProseMirror Node / JSON** | The editor's structured document model, governed by the DA schema (`getSchema()`). |
| **Y.Doc (Yjs CRDT)** | The collaborative state. Document body lives in `ydoc.getXmlFragment('prosemirror')`; doc-level metadata in `ydoc.getMap('daMetadata')`. This is what travels over the collab WebSocket as binary CRDT deltas. |

### Conversion utilities (in `da-tools/da-parser`)

| Function | File | Direction |
|---|---|---|
| `aem2doc(html, ydoc)` | `da-tools/da-parser/src/doc/parser.js` (~line 418) | AEM HTML → Y.Doc (writes into `getXmlFragment('prosemirror')`) |
| `doc2aem(ydoc)` | `da-tools/da-parser/src/doc/parser.js` (~line 733) | Y.Doc → AEM HTML string |
| `parseHTML(html)` | `da-tools/da-parser/src/doc/html-parser.js` | HTML string → HAST tree |
| `getSchema()` | `da-tools/da-parser/src/doc/schema.js` | Builds the ProseMirror schema |
| `prosemirrorToYXmlFragment`, `yDocToProsemirrorJSON`, `yDocToProsemirror` | re-exported from `y-prosemirror` via `da-tools/da-parser/src/index.js` | PM ⟷ Yjs |

The same `@da-tools/da-parser` schema and conversions run **server-side in da-collab** and
**client-side in da-live** (da-live bundles it under `deps/da-parser/dist/index.js`). Keeping the
schema identical on both sides is what makes the CRDT interoperate.

---

## 3. READ trace

The read tool is `content_read` — `da-agent/src/tools/tools.ts:100`. Two paths:

### Path A — live document (collab session connected)
`content_read` → `opts.collab.getContent()` (`src/collab-client.ts:256`) → `doc2aem(ydoc)`.

```
Y.Doc (XmlFragment 'prosemirror' + Map 'daMetadata')   [already synced in memory]
  → yDocToProsemirrorJSON(ydoc)            ProseMirror JSON
  → PMNode.fromJSON(schema, state)         ProseMirror Node
  → DOMSerializer.serializeFragment(...)   lightweight JS-object tree (virtual DOM proxy)
  → tableToBlock / section reconstruction / tohtml()
  → AEM HTML string                        returned as { path, content, source: 'collab' }
```

`useCollabForDoc(org, repo, path, opts)` gates Path A: only when the requested doc *is* the
active page context, the `view` is `edit`/`canvas`, an IMS token is present, and the `DACOLLAB`
service binding is configured. Collab is created in `src/chat-context.ts` (`buildChatContext` →
`createCollabClient`).

### Path B — any other document (no collab)
`content_read` → `client.getSource(org, repo, path)` → HTTP GET da-admin
`/source/{org}/{repo}/{path}` → returns the stored **AEM HTML** verbatim. No conversion.

### (Reference) da-collab's own initial load
When the editor/agent first connects, da-collab builds the `Y.Doc` from source — the inverse of
`doc2aem`:

```
da-admin S3 → AEM HTML
  → parseHTML → HAST tree
  → block→table transforms, section flatten, diff/image fixups
  → DOM proxy → DOMParser.fromSchema(getSchema()).parse → ProseMirror Node
  → prosemirrorToYXmlFragment(node, ydoc.getXmlFragment('prosemirror')) → Y.XmlFragment
```

See `da-collab/src/shareddoc.js` → `persistence.bindState` → `aem2doc`. Subsequent loads may be
restored directly from the Durable Object's serialized Yjs binary (`Y.applyUpdate`) without
re-parsing HTML.

---

## 4. WRITE trace

The write tool is `content_replace_doc` — `da-agent/src/tools/tools.ts:162`. The agent input is
**always a full AEM HTML string** (`content`, must start with `<body>` and end with `</body>`).
Two paths:

### Path A — live document (collab connected) — `src/tools/tools.ts:189`
1. `opts.collab.applyContent(content)` → `src/collab-client.ts:265`
2. `client.updateSource(org, repo, path, content, contentType, { initiator: 'collab' })`
   → POST da-admin with header `X-DA-Initiator: collab`
3. `opts.collab.disconnect()`

`applyContent` is where the **full rewrite** happens today:

```js
// src/collab-client.ts:265
applyContent(html: string): void {
  if (!this.ydoc) return;
  this.ydoc.transact(() => {
    const rootType = this.ydoc!.getXmlFragment('prosemirror');
    rootType.delete(0, rootType.length);          // ← wipes the ENTIRE fragment
    this.ydoc!.share.forEach((type) => {
      if (type instanceof Y.Map) type.clear();    // ← clears daMetadata etc.
    });
    aem2doc(html, this.ydoc!);                     // ← re-parses & re-inserts the WHOLE doc
  });
}
```

Format flow inside `applyContent`:

```
full AEM HTML string
  → parseHTML → HAST tree
  → block→table transforms, section flattening, diff/image fixups
  → DOM proxy → DOMParser.fromSchema(getSchema()).parse → ProseMirror Node
  → prosemirrorToYXmlFragment(node, ydoc.getXmlFragment('prosemirror')) → Y.XmlFragment
```

Because the fragment is cleared then rebuilt, the emitted Yjs update is effectively
**delete-all + insert-all**. Consequences:
- da-live re-renders the entire document.
- Any other user's cursor/selection and the undo stack are disrupted.
- da-collab debounce-saves `doc2aem(ydoc)` back to da-admin/S3 (2s debounce, 10s max wait).

### Path B — any other document (no collab) — `src/tools/tools.ts:198`
`client.updateSource(...)` → POST da-admin → stored verbatim as AEM HTML. da-admin then notifies
da-collab via `notifyCollab('syncadmin', …)` to invalidate live sessions — suppressed when
`X-DA-Initiator: collab` is set, which avoids a write ping-pong.

---

## 5. Format-transformation summary (in order)

```
Read (collab):     Y.Doc → PM JSON → PM Node → virtual DOM → AEM HTML
Read (no collab):  S3 AEM HTML → (verbatim) → agent
Write (collab):    AEM HTML → HAST → PM Node → Y.XmlFragment   (full clear + rebuild)
                   …then async: Y.Doc → PM → virtual DOM → AEM HTML → S3
Write (no collab): AEM HTML → (verbatim) → S3
```

---

## 6. Candidate levels for incremental updates

| # | Level | What it would do | Trade-off |
|---|---|---|---|
| 1 | **Agent/tool** (`da-agent/src/tools/tools.ts`) | Add a new tool (e.g. `content_replace_node`) that addresses a single node instead of the whole body. | Needs a node-addressing scheme (index/anchor/selector) the model can target reliably. |
| 2 | **CollabClient** (`da-agent/src/collab-client.ts`) | Replace the clear-all in `applyContent` with a **targeted `Y.XmlFragment` splice**: `rootType.delete(i, n)` then insert only the re-parsed node(s). | The Y.XmlFragment API is positional, so this is the most natural seam. Needs a way to parse one HTML fragment → Y nodes (level 3). |
| 3 | **Parser** (`da-tools/da-parser`) | Add a partial conversion: parse an HTML *fragment* → ProseMirror node(s) → Y nodes, returnable for splicing. | `aem2doc` currently assumes a full `<body>`; a fragment-scoped variant is needed to support level 2 cleanly. |
| 4 | **Diff** | Keep the full-HTML tool contract; diff old vs. new (HTML or PM tree) and emit only the changed `Y.XmlFragment` ranges. | Most transparent to the model (no new tool, no addressing), but the most logic to build and test. |

### Recommended approach: levels 2 + 3

A targeted splice in `applyContent` backed by a fragment-parsing helper in da-parser:

- Produces a **minimal CRDT delta** → preserves other users' cursors/undo and avoids full
  re-renders in da-live.
- Keeps the existing **AEM-HTML-in / AEM-HTML-out** contract intact — the read path, the
  da-admin POST, and da-collab's save logic are all unchanged.
- Smallest blast radius: the rewrite is localized to one function (`applyContent`) plus one new
  helper in the shared parser.

Open questions for the design pass (resolve before implementing):
1. **Node addressing.** How does the agent identify *which* node to replace? Options: a 0-based
   top-level child index of the prosemirror fragment; a stable `dataId` attribute (the schema
   already carries `topLevelAttrs.dataId` per block — see `da-tools/da-parser/src/doc/schema.js`);
   or a content-match/anchor. The schema's existing `dataId` is the most promising — confirm it is
   populated and stable across the round trip.
2. **Fragment parse granularity.** Can da-parser parse a single block/paragraph of AEM HTML into
   exactly the Y node(s) that occupy one slot of the `prosemirror` fragment? Tables (EDS blocks)
   and `<hr>` section separators are special-cased in `aem2doc`; verify a fragment parse handles
   them.
3. **daMetadata.** The current full rewrite also clears/rebuilds `getMap('daMetadata')`. An
   incremental body edit should leave metadata untouched — make sure the new path does not clear it.
4. **da-admin persistence.** After an incremental Yjs splice, the source of truth still updates via
   da-collab's debounced `doc2aem` save (and/or the existing `updateSource` POST in the tool). Decide
   whether the tool should still POST the *full* serialized HTML (via `collab.getContent()`) or rely
   on da-collab's save — to keep the contract simple, having the tool POST the full current
   `getContent()` after the splice is the low-risk choice.

---

## 7. Key code locations (quick index)

| Symbol | Location |
|---|---|
| `content_read` tool | `da-agent/src/tools/tools.ts:100` |
| `content_create` tool | `da-agent/src/tools/tools.ts:128` |
| `content_replace_doc` tool | `da-agent/src/tools/tools.ts:162` |
| `useCollabForDoc` gate | `da-agent/src/tools/tools.ts` (helper) |
| `CollabClient.getContent` | `da-agent/src/collab-client.ts:256` |
| `CollabClient.applyContent` ← **main seam** | `da-agent/src/collab-client.ts:265` |
| `createCollabClient` factory | `da-agent/src/collab-client.ts:307` |
| Collab wiring (when collab connects) | `da-agent/src/chat-context.ts` (`buildChatContext`) |
| `aem2doc` | `da-tools/da-parser/src/doc/parser.js` (~418) |
| `doc2aem` | `da-tools/da-parser/src/doc/parser.js` (~733) |
| `getSchema` (incl. `dataId` attrs) | `da-tools/da-parser/src/doc/schema.js` |
| da-parser exports | `da-tools/da-parser/src/index.js` |
| da-collab load/save persistence | `da-collab/src/shareddoc.js` (`persistence.bindState` / `update`) |

---

## 8. Verification

To confirm this trace and validate any incremental implementation end-to-end:

- **Static:** Read the anchor functions above — `content_read` / `content_replace_doc`,
  `getContent` / `applyContent`, and `aem2doc` / `doc2aem`.
- **Round trip (manual):** In a da-collab + da-live dev session, have the agent `content_read`
  then `content_replace_doc` and observe (a) the editor re-rendering and (b) da-collab's debounced
  `doc2aem` PUT to da-admin. For the incremental version, confirm only the edited node changes in
  the editor and other users' cursors survive.
- **da-collab side:** Inspect `da-collab/src/shareddoc.js` `persistence.bindState` / `update` to
  confirm the initial-load and save conversions match this trace.
- **Tests:** da-agent uses vitest (`vitest.config.ts`, `test/`). Add unit coverage for the new
  `applyContent` splice path (assert the Yjs delta touches only the targeted slot, and that
  `daMetadata` is preserved).
