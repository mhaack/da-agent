/**
 * Converts MCP tool definitions into Vercel AI SDK tool() objects
 * that can be merged with DA's built-in tools.
 */

import { tool } from 'ai';
import { jsonSchema } from 'ai';
import { MCPClient } from './client.js';
import type { MCPToolDefinition } from './client.js';
import type { MCPServerConfig } from './types.js';

function isRemoteConfig(cfg: MCPServerConfig): boolean {
  return 'url' in cfg && typeof (cfg as any).url === 'string';
}

function getServerUrl(cfg: MCPServerConfig): string | null {
  if (isRemoteConfig(cfg)) return (cfg as any).url;
  // stdio servers need a bridgeUrl to be reachable from Workers
  if ('bridgeUrl' in cfg && typeof (cfg as any).bridgeUrl === 'string') {
    return (cfg as any).bridgeUrl;
  }
  return null;
}

/**
 * Convert a single MCP tool definition into an AI SDK tool.
 * The tool name is prefixed with the serverId: mcp__<serverId>__<toolName>.
 */
function mcpToolToAITool(serverId: string, mcpTool: MCPToolDefinition, mcpClient: MCPClient) {
  const toolName = `mcp__${serverId}__${mcpTool.name}`;
  const description = mcpTool.description ?? `MCP tool ${mcpTool.name} from server ${serverId}`;

  const schema =
    mcpTool.inputSchema && Object.keys(mcpTool.inputSchema).length > 0
      ? jsonSchema(mcpTool.inputSchema as any)
      : jsonSchema({ type: 'object', properties: {} });

  return {
    name: toolName,
    tool: tool({
      description,
      parameters: schema,
      execute: async (args: Record<string, unknown>) => {
        try {
          const result = await mcpClient.callTool(mcpTool.name, args);
          if (result.isError) {
            const errorText = result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
            return { error: errorText };
          }
          const textParts = result.content.filter((c) => c.type === 'text');
          if (textParts.length === 1 && textParts[0].text) return textParts[0].text;
          return result.content;
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  };
}

/**
 * Connect to all reachable MCP servers and register their tools.
 * Returns a flat Record<toolName, tool> that can be spread into the tools object.
 *
 * Connections that fail are silently skipped (best-effort).
 */
export async function connectAndRegisterMCPTools(
  mcpConfig: {
    mcpServers: Record<string, MCPServerConfig>;
    toolAllowPatterns: string[];
  },
  options?: { headers?: Record<string, string>; timeout?: number },
): Promise<{ tools: Record<string, ReturnType<typeof tool>>; clients: MCPClient[] }> {
  const tools: Record<string, ReturnType<typeof tool>> = {};
  const clients: MCPClient[] = [];

  const entries = Object.entries(mcpConfig.mcpServers);

  await Promise.all(
    entries.map(async ([serverId, config]) => {
      const url = getServerUrl(config);
      if (!url) {
        console.log(`MCP server ${serverId}: no reachable URL (stdio without bridgeUrl), skipping`);
        return;
      }

      const serverHeaders = {
        ...(options?.headers ?? {}),
        ...((config as any).headers ?? {}),
      };

      const client = new MCPClient(url, {
        headers: serverHeaders,
        timeout: options?.timeout ?? 15000,
      });

      try {
        await client.initialize();
        const mcpTools = await client.listTools();
        clients.push(client);

        for (const mcpTool of mcpTools) {
          const { name, tool: aiTool } = mcpToolToAITool(serverId, mcpTool, client);
          tools[name] = aiTool;
        }

        console.log(`MCP server ${serverId}: connected, ${mcpTools.length} tool(s) registered`);
      } catch (e) {
        console.log(`MCP server ${serverId}: connection failed: ${e}`);
        try {
          await client.close();
        } catch {
          /* cleanup */
        }
      }
    }),
  );

  return { tools, clients };
}
