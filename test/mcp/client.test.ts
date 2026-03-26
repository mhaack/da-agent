import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPClient } from '../../src/mcp/client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseResponse(events: string[], headers?: Record<string, string>) {
  const body = events.map((e) => `data: ${e}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('MCPClient', () => {
  describe('initialize', () => {
    it('sends initialize request and notifications/initialized', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'test', version: '1.0' },
          },
        }, { 'Mcp-Session-Id': 'session-123' }))
        .mockResolvedValueOnce(new Response(null, { status: 202 }));

      const client = new MCPClient('https://mcp.example.com/mcp');
      await client.initialize();

      expect(client.isInitialized).toBe(true);
      expect(client.currentSessionId).toBe('session-123');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const initCall = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(initCall.method).toBe('initialize');
      expect(initCall.params.protocolVersion).toBe('2025-03-26');

      const notifCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(notifCall.method).toBe('notifications/initialized');
      expect(notifCall.id).toBeUndefined();
    });

    it('includes session ID in subsequent requests', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test' } },
        }, { 'Mcp-Session-Id': 'abc' }))
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(jsonResponse({
          jsonrpc: '2.0', id: 2, result: { tools: [] },
        }));

      const client = new MCPClient('https://mcp.example.com/mcp');
      await client.initialize();
      await client.listTools();

      const listHeaders = mockFetch.mock.calls[2][1].headers;
      expect(listHeaders['Mcp-Session-Id']).toBe('abc');
    });
  });

  describe('listTools', () => {
    it('returns tool definitions', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test' } },
        }))
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(jsonResponse({
          jsonrpc: '2.0', id: 2,
          result: {
            tools: [
              { name: 'get_data', description: 'Fetch data', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
              { name: 'save_data', description: 'Save data' },
            ],
          },
        }));

      const client = new MCPClient('https://mcp.example.com/mcp');
      await client.initialize();
      const tools = await client.listTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('get_data');
      expect(tools[0].description).toBe('Fetch data');
      expect(tools[1].name).toBe('save_data');
    });

    it('throws if not initialized', async () => {
      const client = new MCPClient('https://mcp.example.com/mcp');
      await expect(client.listTools()).rejects.toThrow('not initialized');
    });
  });

  describe('callTool', () => {
    it('calls a tool and returns result', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test' } },
        }))
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(jsonResponse({
          jsonrpc: '2.0', id: 2,
          result: {
            content: [{ type: 'text', text: 'Hello from tool' }],
          },
        }));

      const client = new MCPClient('https://mcp.example.com/mcp');
      await client.initialize();
      const result = await client.callTool('greet', { name: 'World' });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe('Hello from tool');

      const callBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(callBody.method).toBe('tools/call');
      expect(callBody.params.name).toBe('greet');
      expect(callBody.params.arguments).toEqual({ name: 'World' });
    });
  });

  describe('SSE response handling', () => {
    it('parses JSON-RPC response from SSE stream', async () => {
      mockFetch
        .mockResolvedValueOnce(sseResponse([
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test' } } }),
        ]))
        .mockResolvedValueOnce(new Response(null, { status: 202 }));

      const client = new MCPClient('https://mcp.example.com/mcp');
      await client.initialize();
      expect(client.isInitialized).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws on JSON-RPC error response', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          jsonrpc: '2.0', id: 1,
          error: { code: -32600, message: 'Invalid Request' },
        }));

      const client = new MCPClient('https://mcp.example.com/mcp');
      await expect(client.initialize()).rejects.toThrow('Invalid Request');
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }));

      const client = new MCPClient('https://mcp.example.com/mcp');
      await expect(client.initialize()).rejects.toThrow('500');
    });
  });

  describe('close', () => {
    it('sends DELETE request with session ID', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test' } },
        }, { 'Mcp-Session-Id': 'sess-1' }))
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new MCPClient('https://mcp.example.com/mcp');
      await client.initialize();
      await client.close();

      expect(client.isInitialized).toBe(false);
      expect(client.currentSessionId).toBeNull();

      const deleteCall = mockFetch.mock.calls[2];
      expect(deleteCall[1].method).toBe('DELETE');
    });
  });
});
