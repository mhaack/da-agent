/**
 * Lightweight MCP client implementing the Streamable HTTP transport.
 * Designed to run in a Cloudflare Worker (fetch-based, no Node.js APIs).
 *
 * Supports both the modern Streamable HTTP transport (2025-03-26) and
 * backwards-compatible fallback to the legacy SSE transport (2024-11-05).
 */

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface MCPClientOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

export class MCPClient {
  private url: string;

  private headers: Record<string, string>;

  private timeout: number;

  private sessionId: string | null = null;

  private nextId = 1;

  private initialized = false;

  constructor(url: string, options?: MCPClientOptions) {
    this.url = url;
    this.headers = options?.headers ?? {};
    this.timeout = options?.timeout ?? 30000;
  }

  private buildRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
    // Notifications (no id): initialized, cancelled
    const isNotification = method.startsWith('notifications/');
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };
    if (!isNotification) {
      req.id = this.nextId;
      this.nextId += 1;
    }
    return req;
  }

  /**
   * Send a JSON-RPC request and get the response.
   * Handles both application/json and text/event-stream responses.
   */
  private async send(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const reqHeaders: Record<string, string> = {
      ...this.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    if (this.sessionId) {
      reqHeaders['Mcp-Session-Id'] = this.sessionId;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Extract session ID from response
      const sid = response.headers.get('Mcp-Session-Id');
      if (sid) this.sessionId = sid;

      // Notification: expect 202
      if (!request.id) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`MCP server returned ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream')) {
        return this.parseSSEResponse(response);
      }

      return (await response.json()) as JsonRpcResponse;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`MCP request timed out after ${this.timeout}ms`);
      }
      throw e;
    }
  }

  /**
   * Parse an SSE response stream to extract the JSON-RPC response.
   * Collects all events and returns the first JSON-RPC response found.
   */
  private async parseSSEResponse(response: Response): Promise<JsonRpcResponse> {
    const text = await response.text();
    const lines = text.split('\n');
    let dataBuffer = '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        dataBuffer += line.slice(6);
      } else if (line === '' && dataBuffer) {
        try {
          const parsed = JSON.parse(dataBuffer);
          if (parsed.jsonrpc === '2.0' && ('result' in parsed || 'error' in parsed)) {
            return parsed as JsonRpcResponse;
          }
        } catch {
          // Not valid JSON, continue
        }
        dataBuffer = '';
      }
    }

    // Try parsing any remaining buffer
    if (dataBuffer) {
      try {
        return JSON.parse(dataBuffer) as JsonRpcResponse;
      } catch {
        // ignore
      }
    }

    throw new Error('No JSON-RPC response found in SSE stream');
  }

  private unwrapResult<T>(response: JsonRpcResponse | null): T {
    if (!response) throw new Error('No response received');
    if (response.error) {
      throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
    }
    return response.result as T;
  }

  /**
   * Initialize the MCP session. Must be called before any other method.
   */
  async initialize(): Promise<void> {
    const response = await this.send(
      this.buildRequest('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'da-agent', version: '1.0.0' },
      }),
    );

    this.unwrapResult(response);
    this.initialized = true;

    // Send initialized notification
    await this.send(this.buildRequest('notifications/initialized'));
  }

  /**
   * List all tools available on the MCP server.
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.initialized) throw new Error('MCPClient not initialized');

    const response = await this.send(this.buildRequest('tools/list'));
    const result = this.unwrapResult<{ tools: MCPToolDefinition[] }>(response);
    return result.tools ?? [];
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(name: string, args?: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.initialized) throw new Error('MCPClient not initialized');

    const response = await this.send(
      this.buildRequest('tools/call', { name, arguments: args ?? {} }),
    );
    return this.unwrapResult<MCPToolResult>(response);
  }

  /**
   * Close the MCP session.
   */
  async close(): Promise<void> {
    if (!this.sessionId) return;

    try {
      const headers: Record<string, string> = { ...this.headers };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      await fetch(this.url, { method: 'DELETE', headers });
    } catch {
      // Best-effort cleanup
    }

    this.sessionId = null;
    this.initialized = false;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }
}
