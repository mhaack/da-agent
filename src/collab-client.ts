/**
 * CollabClient - Connects to da-collab as the AI Assistant
 *
 * - Connects to da-collab via WebSocket (using DACOLLAB service binding)
 * - Sets awareness state (purple cursor, "AI Assistant (username)")
 * - Read/write document content via getContent() and applyContent(html) using
 *   doc2aem / aem2doc from @da-tools/da-parser (same Y.Doc prosemirror fragment as editor)
 * - Disconnects after request completes (or after applyContent when writing)
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { aem2doc, doc2aem } from '@da-tools/da-parser';

type ActivityState = 'connected' | 'thinking' | 'previewing' | 'done';

/**
 * One addressable top-level block of the document, as surfaced to the agent on read.
 * - `index`   : 0-based position in the prosemirror XmlFragment (for human/debug reference only).
 * - `locator` : opaque, base64-encoded Yjs relative position. The agent copies this back verbatim
 *               to target the block in `replaceRange`; it stays valid under concurrent edits.
 * - `html`    : the block's EDS/AEM HTML (block markup only, no <body>/<main>/section <div>).
 */
export type DocBlock = { index: number; locator: string; html: string };

/** Encode bytes to base64 using Web APIs (works in the Workers runtime). */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Decode a base64 string back to bytes. */
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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

    this.provider = new WebsocketProvider('https://da-collab', this.docPath, this.ydoc, {
      protocols: ['yjs', this.imsToken],
      connect: true,
      disableBc: true,
      // @ts-expect-error -- ServiceBindingWebSocket is compatible but not a WebSocket subclass
      WebSocketPolyfill: WSClass,
    });

    this.provider.on('status', (event: { status: string }) => {
      console.log(`[CollabClient] Status: ${event.status} for ${this.docPath}`);
    });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(
          `[CollabClient] Connection timeout after 3s for ${this.docPath} — proceeding without collab`,
        );
        this.isConnected = false;
        resolve();
      }, 3000);

      this.provider!.on('sync', (isSynced: boolean) => {
        if (isSynced) {
          clearTimeout(timeout);
          this.isConnected = true;
          this.status = 'connected';
          console.log(
            `[CollabClient] Joined collab session: ${this.docPath} as "${this.userName}"`,
          );
          this.setAwarenessState('connected');
          this.setCursorAtStart();
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

      console.log('[CollabClient] Cursor set to start (fragment: prosemirror)');
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
   * Serialize one top-level node to its EDS/AEM HTML (block markup only).
   * Clones the node into a throwaway Y.Doc and reuses doc2aem, then strips the
   * <body>/<main> shell and the section wrapper <div> so the agent sees clean block HTML.
   */
  private static serializeNode(node: Y.XmlElement | Y.XmlText): string {
    const tmp = new Y.Doc();
    tmp.getXmlFragment('prosemirror').insert(0, [node.clone()]);
    const full = doc2aem(tmp);
    const match = full.match(/<main>([\s\S]*)<\/main>/);
    let inner = (match ? match[1] : '').trim();
    if (inner.startsWith('<div>') && inner.endsWith('</div>')) {
      inner = inner.slice('<div>'.length, -'</div>'.length).trim();
    }
    return inner;
  }

  /**
   * Parse an EDS HTML fragment (block markup only) into detached top-level Y nodes.
   * Wraps the fragment in a single section <div> and reuses aem2doc on a throwaway Y.Doc.
   * Throws if the HTML cannot be parsed.
   */
  private static parseFragment(html: string): Y.XmlElement[] {
    const tmp = new Y.Doc();
    aem2doc(`<body><main><div>${html}</div></main></body>`, tmp);
    return tmp.getXmlFragment('prosemirror').toArray() as Y.XmlElement[];
  }

  /**
   * Return the document as a list of addressable top-level blocks.
   * Section separators (horizontal_rule) and empty structural paragraphs are filtered out;
   * each remaining block carries a stable relative-position `locator` for `replaceRange`.
   */
  readBlocks(): DocBlock[] | null {
    if (!this.ydoc) return null;
    const frag = this.ydoc.getXmlFragment('prosemirror');
    const blocks: DocBlock[] = [];
    frag.toArray().forEach((node, index) => {
      if (node instanceof Y.XmlElement && node.nodeName === 'horizontal_rule') return;
      const html = CollabClient.serializeNode(node as Y.XmlElement | Y.XmlText);
      if (!html) return; // skip empty/structural paragraphs
      const rel = Y.createRelativePositionFromTypeIndex(frag, index);
      const locator = encodeBase64(Y.encodeRelativePosition(rel));
      blocks.push({ index, locator, html });
    });
    return blocks;
  }

  /**
   * Replace the contiguous range of top-level nodes [startLocator..endLocator] (inclusive) with
   * the nodes parsed from `html`. `endLocator` omitted/null ⇒ replace just the start block.
   *
   * Fails safe: validates `html` parses to real EDS nodes BEFORE mutating, and errors (rather than
   * corrupting) if a locator no longer resolves. Leaves daMetadata untouched.
   */
  replaceRange(
    startLocator: string,
    endLocator: string | null,
    html: string,
  ): { ok: true } | { error: string } {
    if (!this.ydoc) return { error: 'No active document' };

    // Reject empty/whitespace-only content: the HTML parser would coerce it into an empty
    // node and silently delete the target block. Use content_delete to remove a block.
    if (!html || !html.trim()) {
      return { error: 'Replacement content is empty; use content_delete to remove a block' };
    }

    // Verify the replacement parses to real EDS nodes before touching the live doc.
    let parsed: Y.XmlElement[];
    try {
      parsed = CollabClient.parseFragment(html);
    } catch (e) {
      return { error: `Replacement content is not valid EDS HTML: ${String(e)}` };
    }
    if (parsed.length === 0) {
      return { error: 'Replacement content produced no nodes' };
    }

    const frag = this.ydoc.getXmlFragment('prosemirror');

    const startAbs = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decodeBase64(startLocator)),
      this.ydoc,
    );
    if (!startAbs) {
      return { error: 'Start locator no longer resolves; re-read the document and retry' };
    }
    const start = startAbs.index;

    let end = start; // inclusive index of the last node to replace
    if (endLocator) {
      const endAbs = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(decodeBase64(endLocator)),
        this.ydoc,
      );
      if (!endAbs) {
        return { error: 'End locator no longer resolves; re-read the document and retry' };
      }
      end = endAbs.index;
    }

    if (start < 0 || end < start || end >= frag.length) {
      return { error: 'Invalid locator range' };
    }

    const count = end - start + 1;
    const clones = parsed.map((n) => n.clone());
    this.ydoc.transact(() => {
      frag.delete(start, count);
      frag.insert(start, clones);
    });
    return { ok: true };
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
