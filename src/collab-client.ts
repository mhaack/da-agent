/**
 * CollabClient - Connects to da-collab as the AI Assistant
 *
 * Phase 1: Presence Only
 * - Connects to da-collab via WebSocket (using DACOLLAB service binding)
 * - Sets awareness state (purple cursor, "AI Assistant (username)")
 * - (Minimal) Sets awareness cursor at document start
 * - Disconnects after request completes
 *
 * Content edits still go through MCP → da-admin → R2
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

type ActivityState = "connected" | "thinking" | "previewing" | "done";

/**
 * Creates a WebSocket class that establishes connections via a Cloudflare service binding.
 * Required because WebsocketProvider needs a WebSocket constructor, not an instance.
 */
function createServiceBindingWSClass(binding: Fetcher) {
  return class ServiceBindingWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = 0; // CONNECTING
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;

    private _ws: WebSocket | null = null;

    constructor(url: string, protocols?: string | string[]) {
      super();
      this._connect(url, protocols);
    }

    private async _connect(url: string, protocols?: string | string[]) {
      try {
        const headers: Record<string, string> = { Upgrade: "websocket" };
        if (protocols) {
          headers["Sec-WebSocket-Protocol"] = Array.isArray(protocols)
            ? protocols.join(", ")
            : protocols;
        }

        const response = await binding.fetch(url, { headers });
        const ws = (response as Response & { webSocket: WebSocket | null }).webSocket;

        if (!ws) {
          this._fail("Service binding did not return a WebSocket");
          return;
        }

        this._ws = ws;
        this.readyState = 1; // OPEN

        const openEvent = new Event("open");
        this.dispatchEvent(openEvent);
        this.onopen?.(openEvent);

        ws.addEventListener("message", (event: MessageEvent) => {
          this.dispatchEvent(event);
          this.onmessage?.(event);
        });

        ws.addEventListener("close", (event: CloseEvent) => {
          this.readyState = 3; // CLOSED
          this.dispatchEvent(event);
          this.onclose?.(event);
        });

        ws.addEventListener("error", (event: Event) => {
          this.dispatchEvent(event);
          this.onerror?.(event);
        });
      } catch (error) {
        this._fail(String(error));
      }
    }

    private _fail(reason: string) {
      console.error(`[CollabClient] WebSocket connection failed: ${reason}`);
      this.readyState = 3; // CLOSED
      const errorEvent = new Event("error");
      this.dispatchEvent(errorEvent);
      this.onerror?.(errorEvent);
      const closeEvent = new CloseEvent("close", { code: 1006, reason });
      this.dispatchEvent(closeEvent);
      this.onclose?.(closeEvent);
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
  status: "disconnected" | "connecting" | "connected" | "error" = "disconnected";

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
    this.status = "connecting";

    this.ydoc = new Y.Doc();

    const WSClass = createServiceBindingWSClass(this.binding);

    this.provider = new WebsocketProvider(
      "https://da-collab/source",
      this.docPath,
      this.ydoc,
      {
        protocols: ["yjs", this.imsToken],
        connect: true,
        WebSocketPolyfill: WSClass as unknown as typeof WebSocket
      }
    );

    this.provider.on("status", (event: { status: string }) => {
      console.log(`[CollabClient] Status: ${event.status} for ${this.docPath}`);
    });

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`[CollabClient] Connection timeout for ${this.docPath}`);
        this.isConnected = false;
        resolve();
      }, 5000);

      this.provider!.on("sync", (isSynced: boolean) => {
        if (isSynced) {
          clearTimeout(timeout);
          this.isConnected = true;
          this.status = "connected";
          console.log(`[CollabClient] Synced with da-collab for ${this.docPath}`);
          this.setAwarenessState("connected");
          this.setCursorAtStart();
          resolve();
        }
      });

      this.provider!.on("connection-error", (error: unknown) => {
        clearTimeout(timeout);
        console.error(`[CollabClient] Connection error for ${this.docPath}:`, error);
        this.isConnected = false;
        this.status = "error";
        resolve();
      });
    });
  }

  /**
   * Update AI awareness state (presence + optional cursor)
   * @param activity - Current activity: 'connected' | 'thinking' | 'previewing' | 'done'
   */
  setAwarenessState(activity: ActivityState = "connected"): void {
    if (!this.provider?.awareness) {
      console.warn("[CollabClient] Cannot set awareness - not connected");
      return;
    }

    const state = {
      color: "#9c27b0", // Purple for AI
      name: `AI Assistant (${this.userName})`,
      id: `ai-assistant-${Date.now()}`,
      isAI: true,
      activity
    };

    this.provider.awareness.setLocalStateField("user", state);
    console.log(`[CollabClient] Awareness set: ${state.name} - ${activity}`);
  }

  /**
   * Minimal cursor support: set cursor (anchor/head) to start of the bound Y.XmlFragment.
   * This matches what y-prosemirror's cursor plugin expects: awareness.cursor.{anchor,head}
   * encoded as RelativePosition JSON.
   */
  setCursorAtStart(): void {
    if (!this.provider?.awareness || !this.ydoc) {
      console.warn("[CollabClient] Cannot set cursor - not connected");
      return;
    }

    try {
      const frag = this.ydoc.getXmlFragment("prosemirror");
      const rel = Y.createRelativePositionFromTypeIndex(frag, 0);
      const relJson = Y.relativePositionToJSON(rel);

      this.provider.awareness.setLocalStateField("cursor", {
        anchor: relJson,
        head: relJson
      });

      console.log("[CollabClient] Cursor set to start (fragment: prosemirror)");
    } catch (error) {
      console.warn("[CollabClient] Failed to set cursor at start:", error);
    }
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
    this.status = "disconnected";
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
  binding: Fetcher
): Promise<CollabClient | null> {
  if (!docPath || !imsToken) {
    console.log("[CollabClient] Missing docPath or imsToken, skipping collab");
    return null;
  }

  try {
    const client = new CollabClient(docPath, imsToken, userName, binding);
    await client.connect();
    return client;
  } catch (error) {
    console.error("[CollabClient] Failed to create client:", error);
    return null;
  }
}
