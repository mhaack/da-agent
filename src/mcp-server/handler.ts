/**
 * Lightweight MCP server handler for streamable HTTP transport.
 *
 * Implements the minimum JSON-RPC surface required by the MCP spec:
 * - initialize → server info + capabilities
 * - tools/list → tool definitions
 * - tools/call → tool execution
 * - ping → keepalive
 *
 * No SDK dependency — just JSON-RPC over HTTP. This is the plugin surface
 * Claude Managed Agents (CMA) registers as a remote MCP server; da-agent
 * executes the tool, CMA orchestrates the loop.
 */

import { CORS_HEADERS } from '../auth.js';

export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolRegistry {
  tools: MCPToolDef[];
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SERVER_INFO = {
  name: 'da-agent',
  version: '1.0.0',
};

const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
};

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Serialize a thrown value into a readable, safe message. DAAdminClient rejects
 * with a plain DAAPIError object ({ status, message, details }), not an Error —
 * so `String(err)` would yield "[object Object]". Expose only message + status;
 * omit `details` to avoid leaking backend internals (fail securely).
 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const o = err as { message?: unknown; status?: unknown };
    if (typeof o.message === 'string') {
      return typeof o.status === 'number' ? `${o.message} (status ${o.status})` : o.message;
    }
  }
  return String(err);
}

function jsonResponse(body: JsonRpcResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function handleMCPRequest(
  request: Request,
  registry: MCPToolRegistry,
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonResponse(rpcError(null, -32700, 'Parse error'), 400);
  }

  if (body.jsonrpc !== '2.0') {
    return jsonResponse(rpcError(body.id ?? null, -32600, 'Invalid JSON-RPC'), 400);
  }

  const id = body.id ?? null;

  switch (body.method) {
    case 'initialize':
      return jsonResponse(
        rpcResult(id, {
          protocolVersion: '2025-03-26',
          serverInfo: SERVER_INFO,
          capabilities: SERVER_CAPABILITIES,
        }),
      );

    case 'ping':
      return jsonResponse(rpcResult(id, {}));

    case 'tools/list':
      return jsonResponse(
        rpcResult(id, {
          tools: registry.tools,
        }),
      );

    case 'tools/call': {
      const toolName = (body.params?.name as string) ?? '';
      const toolArgs = (body.params?.arguments as Record<string, unknown>) ?? {};

      const toolDef = registry.tools.find((t) => t.name === toolName);
      if (!toolDef) {
        return jsonResponse(rpcError(id, -32602, `Unknown tool: ${toolName}`));
      }

      try {
        const result = await registry.execute(toolName, toolArgs);
        return jsonResponse(
          rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          }),
        );
      } catch (err) {
        return jsonResponse(
          rpcResult(id, {
            content: [{ type: 'text', text: `Error: ${errorText(err)}` }],
            isError: true,
          }),
        );
      }
    }

    default:
      return jsonResponse(rpcError(id, -32601, `Method not found: ${body.method}`));
  }
}
