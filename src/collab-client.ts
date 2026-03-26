/**
 * CollabClient - Connects to da-collab as the AI Assistant
 *
 * - Connects to da-collab via WebSocket (using DACOLLAB service binding)
 * - Sets awareness state (purple cursor, "AI Assistant (username)")
 * - Read/write document content via getContent() and applyContent(html) using
 *   doc2aem / aem2doc from @da-tools/da-parser (same Y.Doc prosemirror fragment as editor)
 * - Atomic document operations via applyOperations() — each operation moves the cursor
 *   to the target element then applies a minimal DOM change visible to all collaborators
 * - For replace_text: simulates human typing — moves cursor to target, shows selection,
 *   deletes old text, then inserts new text character by character with delays
 * - Disconnects after request completes (or after applyContent when writing)
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { aem2doc, doc2aem, getSchema } from '@da-tools/da-parser';
import {
  absolutePositionToRelativePosition,
  initProseMirrorDoc,
} from 'y-prosemirror';
import { parseHTML as linkedomParseHTML } from 'linkedom';
import type {
  DocumentOperation,
  InsertElementOperation,
  OperationResult,
} from './tools/operations.js';
import { applyOperation } from './tools/dom-operations.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

type ActivityState = 'connected' | 'thinking' | 'previewing' | 'done';

// Set to true to enable verbose debug logging for cursor / Y.js diagnostics.
const DEBUG = true;

const dbg = (...args: any[]) => {
  if (DEBUG) console.log('[CollabClient:debug]', ...args);
};

/**
 * Creates a WebSocket class that establishes connections via a Cloudflare service binding.
 * Required because WebsocketProvider needs a WebSocket constructor, not an instance.
 */
function createServiceBindingWSClass(binding: Fetcher) {
  return class ServiceBindingWebSocket {
    // Static constants (WebSocket API)
    static CONNECTING = 0;

    static OPEN = 1;

    static CLOSING = 2;

    static CLOSED = 3;

    // Instance constants — y-websocket uses `ws.OPEN` (instance), not `WebSocket.OPEN` (static)
    CONNECTING = 0;

    OPEN = 1;

    CLOSING = 2;

    CLOSED = 3;

    readyState = 0; // CONNECTING

    binaryType = 'arraybuffer';

    onopen: ((e: Event) => void) | null = null;

    onmessage: ((e: MessageEvent) => void) | null = null;

    onclose: ((e: CloseEvent) => void) | null = null;

    onerror: ((e: Event) => void) | null = null;

    private _ws: WebSocket | null = null;

    constructor(url: string | URL, protocols?: string | string[]) {
      this._connect(url, protocols);
    }

    private async _connect(url: string | URL, protocols?: string | string[]) {
      try {
        const headers: Record<string, string> = { Upgrade: 'websocket' };
        if (protocols) {
          headers['Sec-WebSocket-Protocol'] = Array.isArray(protocols)
            ? protocols.join(', ')
            : protocols;
        }

        const response = await binding.fetch(url, { headers });
        const ws = (response as Response & { webSocket: WebSocket | null }).webSocket;

        if (!ws) {
          this._fail('Service binding did not return a WebSocket');
          return;
        }

        ws.accept();
        this._ws = ws;
        this.readyState = 1; // OPEN
        this.onopen?.(new Event('open'));

        ws.addEventListener('message', (event: MessageEvent) => {
          this.onmessage?.(event);
        });

        ws.addEventListener('close', (event: CloseEvent) => {
          this.readyState = 3; // CLOSED
          this.onclose?.(event);
        });

        ws.addEventListener('error', (event: Event) => {
          this.onerror?.(event);
        });
      } catch (error) {
        this._fail(String(error));
      }
    }

    private _fail(reason: string) {
      console.error(`[CollabClient] WebSocket connection failed: ${reason}`);
      this.readyState = 3; // CLOSED
      this.onerror?.(new Event('error'));
      this.onclose?.(new CloseEvent('close', { code: 1006, reason }));
    }

    send(data: string | ArrayBuffer | Uint8Array): void {
      this._ws?.send(data);
    }

    close(code?: number, reason?: string): void {
      if (this._ws) {
        this.readyState = 2; // CLOSING
        this._ws.close(code, reason);
      }
    }
  };
}

export class CollabClient {
  private docPath: string;

  private imsToken: string;

  private userName: string;

  private binding: Fetcher;

  private ydoc: Y.Doc | null = null;

  private provider: WebsocketProvider | null = null;

  isConnected = false;

  status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

  constructor(docPath: string, imsToken: string, userName: string, binding: Fetcher) {
    this.docPath = docPath;
    this.imsToken = imsToken;
    this.userName = userName;
    this.binding = binding;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Connect to da-collab and set AI presence
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      console.log(`[CollabClient] Already connected to ${this.docPath}`);
      return;
    }

    console.log(`[CollabClient] Connecting to da-collab for doc: ${this.docPath}`);
    this.status = 'connecting';

    this.ydoc = new Y.Doc();

    const WSClass = createServiceBindingWSClass(this.binding);

    this.provider = new WebsocketProvider(
      // 'https://da-collab',
      'http://localhost:4711',
      this.docPath,
      this.ydoc,
      {
        protocols: ['yjs', this.imsToken],
        connect: true,
        disableBc: true,
        // @ts-expect-error -- ServiceBindingWebSocket is compatible but not a WebSocket subclass
        WebSocketPolyfill: WSClass,
      },
    );

    this.provider.on('status', (event: { status: string }) => {
      console.log(`[CollabClient] Status: ${event.status} for ${this.docPath}`);
    });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`[CollabClient] Connection timeout after 5s for ${this.docPath} — proceeding without collab`);
        this.isConnected = false;
        resolve();
      }, 5000);

      this.provider!.on('sync', (isSynced: boolean) => {
        if (isSynced) {
          clearTimeout(timeout);
          this.isConnected = true;
          this.status = 'connected';
          console.log(`[CollabClient] Joined collab session: ${this.docPath} as "${this.userName}"`);
          this.setAwarenessState('connected');
          resolve();
        }
      });

      this.provider!.on('connection-error', (error: unknown) => {
        clearTimeout(timeout);
        console.error(`[CollabClient] Failed to join collab session for ${this.docPath}:`, error);
        this.isConnected = false;
        this.status = 'error';
        resolve();
      });
    });
  }

  /**
   * Update AI awareness state (presence + optional cursor)
   * @param activity - Current activity: 'connected' | 'thinking' | 'previewing' | 'done'
   */
  setAwarenessState(activity: ActivityState = 'connected'): void {
    if (!this.provider?.awareness) {
      console.warn('[CollabClient] Cannot set awareness - not connected');
      return;
    }

    const state = {
      color: '#9c27b0', // Purple for AI
      name: `AI Assistant (${this.userName})`,
      id: `ai-assistant-${Date.now()}`,
      isAI: true,
      activity,
    };

    this.provider.awareness.setLocalStateField('user', state);
    console.log(`[CollabClient] Awareness set: ${state.name} - ${activity}`);
  }

  /**
   * Minimal cursor support: set cursor (anchor/head) to start of the bound Y.XmlFragment.
   * This matches what y-prosemirror's cursor plugin expects: awareness.cursor.{anchor,head}
   * encoded as RelativePosition JSON.
   */
  setCursorAtStart(): void {
    if (!this.provider?.awareness || !this.ydoc) {
      console.warn('[CollabClient] Cannot set cursor - not connected');
      return;
    }

    try {
      const frag = this.ydoc.getXmlFragment('prosemirror');
      const rel = Y.createRelativePositionFromTypeIndex(frag, 0);
      const relJson = Y.relativePositionToJSON(rel);

      this.provider.awareness.setLocalStateField('cursor', {
        anchor: relJson,
        head: relJson,
      });

      dbg('setCursorAtStart: set cursor to fragment start, relJson=', JSON.stringify(relJson));
    } catch (error) {
      console.warn('[CollabClient] Failed to set cursor at start:', error);
    }
  }

  /**
   * Return the current document as EDS HTML (same format as da-admin source).
   * Uses doc2aem(ydoc) on the shared prosemirror XmlFragment.
   */
  getContent(): string | null {
    if (!this.ydoc) return null;
    return doc2aem(this.ydoc);
  }

  /**
   * Apply EDS HTML to the shared Y doc (editor sees it live).
   * Uses aem2doc(html, ydoc) inside a transaction; clears the prosemirror fragment first.
   */
  applyContent(html: string): void {
    if (!this.ydoc) return;
    this.ydoc.transact(() => {
      const rootType = this.ydoc!.getXmlFragment('prosemirror');
      rootType.delete(0, rootType.length);
      this.ydoc!.share.forEach((type) => {
        if (type instanceof Y.Map) {
          type.clear();
        }
      });
      aem2doc(html, this.ydoc!);
    });
  }

  /**
   * Move the AI cursor to the Nth block element in the document.
   * Uses the real mapping from initProseMirrorDoc so positions resolve correctly in the editor.
   * Must be called AFTER any Y.doc transact so the positions point to live Y.js items.
   */
  setCursorAtElement(elementIndex: number): void {
    if (!this.provider?.awareness || !this.ydoc) return;
    try {
      const schema = getSchema();
      const type = this.ydoc.getXmlFragment('prosemirror');
      const { doc, mapping } = initProseMirrorDoc(type, schema);

      dbg(`setCursorAtElement(${elementIndex}): mapping.size=${mapping.size}, doc.childCount=${doc.childCount}`);

      // Walk the document to find the ProseMirror position of the start of block N.
      // Position 1 = inside the first block's opening node.
      let pos = 1;
      for (let i = 0; i < elementIndex && i < doc.childCount; i += 1) {
        pos += doc.child(i).nodeSize;
      }
      pos = Math.min(pos, doc.content.size);

      const anchor = absolutePositionToRelativePosition(pos, type, mapping as any);
      const anchorJson = Y.relativePositionToJSON(anchor);

      dbg(`setCursorAtElement(${elementIndex}): pmPos=${pos}, relJson=${JSON.stringify(anchorJson)}`);

      this.provider.awareness.setLocalStateField('cursor', {
        anchor: anchorJson,
        head: anchorJson,
      });
      console.log(`[CollabClient] Cursor moved to block ${elementIndex} (pmPos=${pos})`);
    } catch (err) {
      console.warn('[CollabClient] Failed to set cursor at element:', err);
      this.setCursorAtStart(); // Fallback to document start
    }
  }

  /**
   * Set cursor (and optionally a selection range) using exact ProseMirror positions.
   * When from !== to, collaborators see a highlighted selection range — used to show
   * which text the agent is about to change.
   * Requires the mapping returned by initProseMirrorDoc for accurate Y.js relative positions.
   */
  private setCursorAtPmPosition(
    from: number,
    to: number,
    mapping: Map<any, any>,
    type: Y.XmlFragment,
  ): void {
    if (!this.provider?.awareness) return;
    try {
      const anchor = absolutePositionToRelativePosition(from, type, mapping as any);
      const head = absolutePositionToRelativePosition(to, type, mapping as any);
      const anchorJson = Y.relativePositionToJSON(anchor);
      const headJson = Y.relativePositionToJSON(head);

      dbg(
        `setCursorAtPmPosition: from=${from} to=${to}`,
        `anchor=${JSON.stringify(anchorJson)}`,
        `head=${JSON.stringify(headJson)}`,
      );

      this.provider.awareness.setLocalStateField('cursor', {
        anchor: anchorJson,
        head: headJson,
      });
    } catch (err) {
      console.warn('[CollabClient] setCursorAtPmPosition failed:', err);
    }
  }

  /**
   * Log the full Y.XmlFragment tree for debugging.
   */
  private dumpYXmlFragment(): void {
    if (!this.ydoc) return;
    const frag = this.ydoc.getXmlFragment('prosemirror');
    const children = (frag as any).toArray();
    dbg(`Y.XmlFragment 'prosemirror' has ${children.length} top-level child(ren):`);
    children.forEach((child: any, i: number) => {
      const ctor = child?.constructor?.name ?? 'unknown';
      if (child instanceof Y.XmlText) {
        const plain = child.toDelta().map((d: any) => d.insert).join('');
        dbg(`  [${i}] Y.XmlText (${child._length} chars) plain="${plain.slice(0, 80)}"`);
      } else if (child instanceof Y.XmlElement) {
        const grandChildren = (child as any).toArray();
        dbg(`  [${i}] Y.XmlElement(${child.nodeName}) with ${grandChildren.length} child(ren):`);
        grandChildren.forEach((gc: any, j: number) => {
          const gcCtor = gc?.constructor?.name ?? 'unknown';
          if (gc instanceof Y.XmlText) {
            const plain = gc.toDelta().map((d: any) => d.insert).join('');
            dbg(`    [${j}] Y.XmlText (${gc._length} chars) plain="${plain.slice(0, 80)}"`);
          } else {
            dbg(`    [${j}] ${gcCtor} (nodeName=${gc.nodeName ?? 'n/a'})`);
          }
        });
      } else {
        dbg(`  [${i}] ${ctor}`);
      }
    });
  }

  /**
   * Walk the Y.XmlFragment tree to find the Y.XmlText node containing the nth occurrence
   * of `find`. Returns the node and the character offset within it where `find` starts.
   *
   * Uses toDelta() to get the PLAIN TEXT content (not toString() which embeds XML markup).
   * Returns null if not found (e.g. text spans multiple Y.XmlText nodes due to formatting).
   */
  private findYXmlText(
    find: string,
    nth: number,
  ): { ytext: Y.XmlText; charOffset: number } | null {
    if (!this.ydoc) return null;
    const frag = this.ydoc.getXmlFragment('prosemirror');
    let count = 0;

    type YXmlTextResult = { ytext: Y.XmlText; charOffset: number };
    const walk = (node: Y.XmlFragment | Y.XmlElement): YXmlTextResult | null => {
      for (const child of (node as any).toArray()) {
        if (child instanceof Y.XmlText) {
          // Use toDelta() for plain text — toString() embeds XML markup for formatted runs
          const plain = child.toDelta().map((d: any) => d.insert as string).join('');
          const idx = plain.indexOf(find);
          dbg(
            `findYXmlText: checking Y.XmlText (${child._length} chars),`,
            `plain[0..60]="${plain.slice(0, 60)}", indexOf("${find.slice(0, 30)}")=${idx}`,
          );
          if (idx >= 0) {
            count += 1;
            if (count === nth) {
              dbg(`findYXmlText: FOUND at occurrence ${nth}, charOffset=${idx}`);
              return { ytext: child, charOffset: idx };
            }
          }
        } else if (child instanceof Y.XmlElement) {
          const result = walk(child);
          if (result) return result;
        }
      }
      return null;
    };

    const result = walk(frag);
    if (!result) {
      dbg(`findYXmlText: "${find.slice(0, 40)}" NOT found in Y.XmlFragment (nth=${nth})`);
    }
    return result;
  }

  /**
   * Find the index of the top-level Y.XmlFragment child whose subtree contains the anchor text.
   * Returns -1 if not found.
   */
  private findFragmentChildIndex(anchor: string, anchorIndex = 1): number {
    if (!this.ydoc) return -1;
    const frag = this.ydoc.getXmlFragment('prosemirror');
    const children = (frag as any).toArray();

    const getNodeText = (node: any): string => {
      if (node instanceof Y.XmlText) {
        return node.toDelta().map((d: any) => d.insert as string).join('');
      }
      if (node instanceof Y.XmlElement) {
        return (node as any).toArray().map(getNodeText).join('');
      }
      return '';
    };

    let count = 0;
    for (let i = 0; i < children.length; i += 1) {
      if (getNodeText(children[i]).includes(anchor)) {
        count += 1;
        if (count === anchorIndex) {
          dbg(`findFragmentChildIndex: found "${anchor.slice(0, 40)}" at index=${i} (occ ${anchorIndex})`);
          return i;
        }
      }
    }
    dbg(`findFragmentChildIndex: "${anchor.slice(0, 40)}" NOT found`);
    return -1;
  }

  /**
   * Return a text excerpt from the block element where the human user's cursor is positioned.
   * Reads the other (non-AI) user's awareness cursor, resolves the relative position to a
   * top-level Y.XmlFragment child, and returns the first 100 chars of its plain text.
   * Returns null if the cursor cannot be determined (e.g. no other user connected yet).
   */
  private getUserCursorAnchor(): string | null {
    if (!this.ydoc || !this.provider?.awareness) return null;
    const { awareness } = this.provider;
    const myId = awareness.clientID;
    const frag = this.ydoc.getXmlFragment('prosemirror');
    const fragChildren = (frag as any).toArray() as any[];

    const getNodeText = (node: any): string => {
      if (node instanceof Y.XmlText) return node.toDelta().map((d: any) => d.insert as string).join('');
      if (node instanceof Y.XmlElement) return (node as any).toArray().map(getNodeText).join('');
      return '';
    };

    for (const [clientId, state] of awareness.getStates()) {
      if (clientId !== myId) { // skip the AI's own cursor
        const cursorAnchor = state?.cursor?.anchor;
        if (cursorAnchor) {
          try {
            const relPos = Y.createRelativePositionFromJSON(cursorAnchor);
            const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, this.ydoc);
            if (absPos?.type) {
              // Walk up through parent references until we find a direct child of frag
              let node: any = absPos.type;
              while (node && (node as any).parent !== frag) {
                node = (node as any).parent;
              }
              if (node) {
                const idx = fragChildren.indexOf(node);
                if (idx >= 0) {
                  const text = getNodeText(node).trim();
                  if (text) {
                    dbg(`getUserCursorAnchor: user cursor at frag[${idx}] = "${text.slice(0, 60)}"`);
                    return text.slice(0, 100);
                  }
                }
              }
            }
          } catch {
            // ignore — position may be stale or unresolvable
          }
        }
      }
    }
    return null;
  }

  /**
   * Extract plain text content from an HTML fragment string using DOMParser.
   */
  private static extractTextFromHtml(html: string): string {
    const fullDoc = `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
    const { document: dom } = linkedomParseHTML(fullDoc) as any;
    return (dom.body?.textContent ?? '') as string;
  }

  /**
   * Simulate human-like element insertion for insert_element operations:
   *   1. Move cursor to the anchor element (collaborators see cursor jump)
   *   2. Apply DOM change via aem2doc (new element appears in editor)
   *   3. Delete the new element's text immediately (empty line visible)
   *   4. Move cursor to the new empty element
   *   5. Type the text one character at a time with delays (text appears as typed)
   *
   * For complex elements (no direct Y.XmlText child), skips the typing simulation
   * but still pre-positions the cursor at the anchor before applying the change.
   */
  private async applyInsertElementWithTyping(
    currentHtml: string,
    op: InsertElementOperation,
  ): Promise<{ success: boolean; newHtml: string; message: string }> {
    if (!this.ydoc) {
      return { success: false, newHtml: currentHtml, message: 'Not connected' };
    }

    dbg(
      `applyInsertElementWithTyping: anchor="${op.anchor.slice(0, 40)}"`,
      `pos=${op.insertPosition}, html="${op.html.slice(0, 60)}"`,
    );
    this.dumpYXmlFragment();

    // Step 1: Find anchor in fragment and move cursor there (visible jump)
    const anchorFragIdx = this.findFragmentChildIndex(op.anchor, op.anchorIndex ?? 1);
    if (anchorFragIdx >= 0) {
      this.setCursorAtElement(anchorFragIdx);
      await CollabClient.sleep(38);
    }

    // Step 2: Apply DOM operation to get updated HTML
    let domResult: ReturnType<typeof applyOperation>;
    try {
      domResult = applyOperation(currentHtml, op);
    } catch (domErr) {
      dbg(`applyInsertElementWithTyping: applyOperation THREW: ${String(domErr)}`);
      return { success: false, newHtml: currentHtml, message: String(domErr) };
    }
    if (!domResult.success) {
      dbg(`applyInsertElementWithTyping: DOM op failed: ${domResult.message}`);
      return { success: false, newHtml: currentHtml, message: domResult.message };
    }

    const insertText = CollabClient.extractTextFromHtml(op.html);
    dbg(`applyInsertElementWithTyping: insertText="${insertText.slice(0, 60)}"`);

    // Step 3: Apply aem2doc — new element appears in editor
    this.ydoc.transact(() => {
      const fragInner = this.ydoc!.getXmlFragment('prosemirror');
      fragInner.delete(0, fragInner.length);
      this.ydoc!.share.forEach((sharedType) => {
        if (sharedType instanceof Y.Map) sharedType.clear();
      });
      aem2doc(domResult.newHtml, this.ydoc!);
    });

    // Step 4: Find the new element by locating the anchor in the fragment (post-aem2doc)
    // and offsetting by insertPosition. This avoids the DOM blockIndex vs fragment index mismatch.
    const postAnchorFragIdx = this.findFragmentChildIndex(op.anchor, op.anchorIndex ?? 1);
    const newElementIndex = postAnchorFragIdx >= 0
      ? postAnchorFragIdx + (op.insertPosition === 'after' ? 1 : 0)
      : -1;
    dbg(`applyInsertElementWithTyping: postAnchorFragIdx=${postAnchorFragIdx}, newElementIndex=${newElementIndex}`);

    // Step 5: If there's a direct Y.XmlText child in the new element, delete its text and retype
    if (insertText && newElementIndex >= 0) {
      const frag = this.ydoc.getXmlFragment('prosemirror');
      const newEl = (frag as any).toArray()[newElementIndex];

      if (newEl instanceof Y.XmlElement) {
        const ytext = (newEl as any).toArray().find((c: any) => c instanceof Y.XmlText);
        if (ytext) {
          const currentPlain = ytext.toDelta().map((d: any) => d.insert as string).join('');
          dbg(`applyInsertElementWithTyping: deleting ${currentPlain.length} chars, then retyping`);

          // Delete all text in one transaction (text disappears, empty line visible)
          this.ydoc.transact(() => {
            ytext.delete(0, currentPlain.length);
          });
          this.setCursorAtElement(newElementIndex);
          await CollabClient.sleep(38);

          // Type word by word — sequential awaits are intentional
          /* eslint-disable no-await-in-loop */
          const words = insertText.split(' ');
          let offset = 0;
          for (let i = 0; i < words.length; i += 1) {
            const chunk = i < words.length - 1 ? `${words[i]} ` : words[i];
            const chunkCopy = chunk;
            const offsetCopy = offset;
            this.ydoc.transact(() => {
              ytext.insert(offsetCopy, chunkCopy);
            });
            offset += chunk.length;
            await CollabClient.sleep(20);
          }
          /* eslint-enable no-await-in-loop */

          dbg(`applyInsertElementWithTyping: typed ${words.length} words`);
        } else {
          // Complex block — cursor set only, no typing animation
          this.setCursorAtElement(newElementIndex);
          dbg(`applyInsertElementWithTyping: complex element, cursor moved to ${newElementIndex}`);
        }
      }
    }

    const newHtml = this.getContent() ?? domResult.newHtml;
    dbg(`applyInsertElementWithTyping: done, getContent()="${newHtml.slice(0, 200)}"`);
    console.log(`[CollabClient] Inserted element ${op.insertPosition} "${op.anchor.slice(0, 40)}"`);
    return { success: true, newHtml, message: domResult.message };
  }

  /**
   * Simulate human-like text replacement for replace_text operations:
   *   1. Move cursor to the start of the target text (collaborators see cursor jump)
   *   2. Extend selection to cover the full old text (collaborators see it highlighted)
   *   3. Pause briefly so the selection is visible
   *   4. Delete the old text in one Y.js transaction (text disappears)
   *   5. Insert the new text one character at a time with a short delay (text appears as typed)
   *
   * Falls back to full aem2doc rebuild if the target text is not found in the Y.XmlFragment
   * (e.g. text spans multiple Y.XmlText nodes due to inline formatting marks).
   */
  private async applyReplaceTextWithTyping(
    currentHtml: string,
    find: string,
    replace: string,
    nth: number,
  ): Promise<{ success: boolean; newHtml: string; message: string }> {
    if (!this.ydoc) {
      return { success: false, newHtml: currentHtml, message: 'Not connected' };
    }

    dbg(`applyReplaceTextWithTyping: find="${find.slice(0, 40)}", replace="${replace.slice(0, 40)}", nth=${nth}`);
    this.dumpYXmlFragment();

    // Find the Y.XmlText node containing the target text
    const ytextResult = this.findYXmlText(find, nth);

    if (!ytextResult) {
      // Fallback: apply via DOM + aem2doc (handles cross-node spans)
      // Still animate: cursor at block → instant delete via aem2doc → retype word-by-word
      dbg('applyReplaceTextWithTyping: falling back to DOM+aem2doc with animation');

      // Step 1: Move cursor to the block containing the find text (visual cue)
      const preBlockIdx = this.findFragmentChildIndex(find);
      if (preBlockIdx >= 0) {
        this.setCursorAtElement(preBlockIdx);
        await CollabClient.sleep(500);
      }

      let domResult: ReturnType<typeof applyOperation>;
      try {
        domResult = applyOperation(currentHtml, {
          type: 'replace_text', find, replace, nth,
        });
      } catch (domErr) {
        dbg('applyReplaceTextWithTyping: applyOperation THREW:', String(domErr));
        return { success: false, newHtml: currentHtml, message: String(domErr) };
      }
      if (!domResult.success) {
        dbg('applyReplaceTextWithTyping: DOM op failed:', domResult.message);
        return { success: false, newHtml: currentHtml, message: domResult.message };
      }

      // Step 2: Apply aem2doc so new content appears (collaborators see change)
      this.ydoc.transact(() => {
        const frag = this.ydoc!.getXmlFragment('prosemirror');
        frag.delete(0, frag.length);
        this.ydoc!.share.forEach((type) => {
          if (type instanceof Y.Map) type.clear();
        });
        aem2doc(domResult.newHtml, this.ydoc!);
      });

      // Step 3: Find the replace text in the freshly rebuilt fragment and retype it word-by-word
      if (replace.trim()) {
        const newYtextResult = this.findYXmlText(replace, nth);
        if (newYtextResult) {
          const { ytext: newYtext, charOffset: newCharOffset } = newYtextResult;
          // Delete the already-inserted replacement text (it disappears)
          this.ydoc.transact(() => {
            newYtext.delete(newCharOffset, replace.length);
          });
          // Position cursor at the now-empty spot
          const postBlockIdx = this.findFragmentChildIndex(
            newYtext.toDelta().map((d: any) => d.insert as string).join('').slice(0, 30),
          );
          if (postBlockIdx >= 0) this.setCursorAtElement(postBlockIdx);
          await CollabClient.sleep(38);
          // Retype word-by-word
          const words = replace.split(' ');
          let offset = newCharOffset;
          /* eslint-disable no-await-in-loop */
          for (let i = 0; i < words.length; i += 1) {
            const chunk = i < words.length - 1 ? `${words[i]} ` : words[i];
            const chunkCopy = chunk;
            const offsetCopy = offset;
            this.ydoc.transact(() => {
              newYtext.insert(offsetCopy, chunkCopy);
            });
            offset += chunk.length;
            await CollabClient.sleep(20);
          }
          /* eslint-enable no-await-in-loop */
          dbg(`applyReplaceTextWithTyping: fallback retyped ${words.length} words`);
        } else {
          // Can't find replace text (complex formatting) — just set cursor at block
          const postBlockIdx = this.findFragmentChildIndex(replace.slice(0, 30));
          if (postBlockIdx >= 0) this.setCursorAtElement(postBlockIdx);
          dbg('applyReplaceTextWithTyping: fallback could not find replace text for retyping');
        }
      }

      const preview = this.getContent()?.slice(0, 200);
      dbg(`applyReplaceTextWithTyping: aem2doc fallback done, getContent()="${preview}"`);
      return {
        success: true,
        newHtml: this.getContent() ?? domResult.newHtml,
        message: domResult.message,
      };
    }

    const { ytext, charOffset } = ytextResult;
    dbg(`applyReplaceTextWithTyping: found Y.XmlText, charOffset=${charOffset}, ytext._length=${ytext._length}`);

    // Compute ProseMirror positions of the target text for cursor/selection awareness
    const schema = getSchema();
    const type = this.ydoc.getXmlFragment('prosemirror');
    const { doc, mapping } = initProseMirrorDoc(type, schema);
    dbg(`applyReplaceTextWithTyping: initProseMirrorDoc mapping.size=${mapping.size}, doc.childCount=${doc.childCount}`);

    let fromPm = -1;
    let toPm = -1;
    doc.descendants((node: any, pos: number) => {
      if (fromPm >= 0) return false;
      if (node.isText && typeof node.text === 'string') {
        const idx = node.text.indexOf(find);
        if (idx >= 0) {
          fromPm = pos + idx;
          toPm = fromPm + find.length;
          dbg(`applyReplaceTextWithTyping: found PM text at pos=${pos}, idx=${idx}, fromPm=${fromPm}, toPm=${toPm}`);
        }
      }
      return true;
    });

    if (fromPm < 0) {
      dbg('applyReplaceTextWithTyping: text found in Y.XmlText but not in PM doc — unexpected');
    }

    // Step 1: Move cursor to start of target text
    if (fromPm >= 0) {
      this.setCursorAtPmPosition(fromPm, fromPm, mapping, type);
      await CollabClient.sleep(38);

      // Step 2: Extend selection to cover the full old text
      this.setCursorAtPmPosition(fromPm, toPm, mapping, type);
      dbg(`applyReplaceTextWithTyping: selection set from ${fromPm} to ${toPm}, sleeping 175ms`);
      await CollabClient.sleep(500);
    }

    // Step 3: Delete old text in one transaction (collaborators see it disappear)
    dbg(`applyReplaceTextWithTyping: deleting ${find.length} chars at charOffset=${charOffset}`);
    this.ydoc.transact(() => {
      ytext.delete(charOffset, find.length);
    });
    dbg(`applyReplaceTextWithTyping: after delete, ytext._length=${ytext._length}, plain="${ytext.toDelta().map((d: any) => d.insert).join('').slice(0, 60)}"`);
    await CollabClient.sleep(20);

    // Recompute mapping after deletion so cursor positions are accurate
    const { mapping: postDeleteMapping } = initProseMirrorDoc(type, schema);
    if (fromPm >= 0) {
      this.setCursorAtPmPosition(fromPm, fromPm, postDeleteMapping, type);
    }

    // Step 4: Insert new text word by word (collaborators see it being typed).
    // Sequential awaits are intentional — each delay lets the UI render the typed word.
    /* eslint-disable no-await-in-loop */
    dbg(`applyReplaceTextWithTyping: typing ${replace.split(' ').length} words...`);
    const replaceWords = replace.split(' ');
    let replaceOffset = charOffset;
    for (let i = 0; i < replaceWords.length; i += 1) {
      const chunk = i < replaceWords.length - 1 ? `${replaceWords[i]} ` : replaceWords[i];
      const chunkCopy = chunk;
      const offsetCopy = replaceOffset;
      this.ydoc.transact(() => {
        ytext.insert(offsetCopy, chunkCopy);
      });
      replaceOffset += chunk.length;
      await CollabClient.sleep(20);
    }
    /* eslint-enable no-await-in-loop */

    const newHtml = this.getContent() ?? currentHtml;
    dbg(`applyReplaceTextWithTyping: done. getContent() snippet="${newHtml.slice(0, 200)}"`);
    console.log(`[CollabClient] Typed "${replace.slice(0, 40)}" in place of "${find.slice(0, 40)}"`);
    return {
      success: true,
      newHtml,
      message: `Replaced "${find}" with "${replace}"`,
    };
  }

  /**
   * Apply a list of atomic document operations sequentially.
   *
   * replace_text operations use human-like typing simulation: cursor → selection → delete → type.
   * All other operations apply DOM changes via aem2doc and move the cursor to the affected block.
   * read_content is a no-op for document change — it returns the current HTML.
   *
   * Returns a promise that resolves to an array of per-operation results.
   */
  async applyOperations(operations: DocumentOperation[]): Promise<OperationResult[]> {
    if (!this.ydoc) {
      return operations.map((op) => ({
        type: op.type,
        success: false,
        message: 'Not connected to collab session',
      }));
    }

    dbg(`applyOperations: ${operations.length} operation(s): ${operations.map((o) => o.type).join(', ')}`);
    dbg(`applyOperations: isConnected=${this.isConnected}, provider.awareness=${!!this.provider?.awareness}`);

    const results: OperationResult[] = [];
    let currentHtml = this.getContent() ?? '<body><main><div></div></main></body>';
    dbg(`applyOperations: initial getContent() snippet="${currentHtml.slice(0, 200)}"`);

    for (const op of operations) {
      dbg(`applyOperations: processing op.type="${op.type}"`);

      if (op.type === 'read_content') {
        results.push({
          type: 'read_content',
          success: true,
          message: 'Content read successfully',
          content: currentHtml,
          cursorAnchor: this.getUserCursorAnchor(),
        });
      } else if (op.type === 'replace_text') {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.applyReplaceTextWithTyping(
          currentHtml,
          op.find,
          op.replace,
          op.nth ?? 1,
        );
        if (result.success) {
          currentHtml = result.newHtml;
        }
        dbg(`applyOperations: replace_text result: success=${result.success}, message="${result.message}"`);
        results.push({
          type: op.type,
          success: result.success,
          message: result.message,
        });
      } else if (op.type === 'insert_element') {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.applyInsertElementWithTyping(currentHtml, op);
        if (result.success) {
          currentHtml = result.newHtml;
        }
        dbg(`applyOperations: insert_element result: success=${result.success}, message="${result.message}"`);
        results.push({
          type: op.type,
          success: result.success,
          message: result.message,
        });
      } else {
        // For operations with an anchor, move cursor to the target element before applying.
        // This gives collaborators a visual cue of what is about to change.
        if ('anchor' in op) {
          const fragIdx = this.findFragmentChildIndex(
            (op as any).anchor as string,
            (op as any).anchorIndex ?? 1,
          );
          if (fragIdx >= 0) {
            this.setCursorAtElement(fragIdx);
            // eslint-disable-next-line no-await-in-loop
            await CollabClient.sleep(38);
          }
        }
        let result: ReturnType<typeof applyOperation>;
        try {
          result = applyOperation(currentHtml, op);
        } catch (domErr) {
          dbg(`applyOperations: ${op.type} applyOperation THREW: ${String(domErr)}`);
          results.push({ type: op.type, success: false, message: String(domErr) });
          continue; // eslint-disable-line no-continue
        }
        dbg(`applyOperations: ${op.type} result: success=${result.success}, message="${result.message}", blockIndex=${result.blockIndex}`);
        if (result.success) {
          currentHtml = result.newHtml;
          this.ydoc.transact(() => {
            const fragInner = this.ydoc!.getXmlFragment('prosemirror');
            fragInner.delete(0, fragInner.length);
            this.ydoc!.share.forEach((sharedType) => {
              if (sharedType instanceof Y.Map) sharedType.clear();
            });
            aem2doc(result.newHtml, this.ydoc!);
          });
          // Cursor set AFTER transact: points to newly created Y.js items
          if (result.blockIndex >= 0) {
            this.setCursorAtElement(result.blockIndex);
          }
        }
        results.push({
          type: op.type,
          success: result.success,
          message: result.message,
        });
      }
    }

    dbg(`applyOperations: finished. results=${JSON.stringify(results)}`);
    return results;
  }

  /**
   * Disconnect from da-collab
   */
  disconnect(): void {
    if (!this.provider) return;

    console.log(`[CollabClient] Disconnecting from ${this.docPath}`);

    if (this.provider.awareness) {
      this.provider.awareness.setLocalState(null);
    }

    this.provider.disconnect();
    this.provider.destroy();
    this.provider = null;

    this.ydoc?.destroy();
    this.ydoc = null;

    this.isConnected = false;
    this.status = 'disconnected';
  }
}

/**
 * Factory function to create and connect a CollabClient.
 * Returns null if connection fails (graceful degradation).
 */
export async function createCollabClient(
  docPath: string,
  imsToken: string,
  userName: string,
  binding: Fetcher,
): Promise<CollabClient | null> {
  if (!docPath || !imsToken) {
    console.log('[CollabClient] Missing docPath or imsToken, skipping collab');
    return null;
  }

  try {
    const client = new CollabClient(docPath, imsToken, userName, binding);
    await client.connect();
    return client;
  } catch (error) {
    console.error('[CollabClient] Failed to create client:', error);
    return null;
  }
}
