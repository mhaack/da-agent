/**
 * Converts MCP tool definitions into Vercel AI SDK tool() objects
 * that can be merged with DA's built-in tools.
 */

import { tool, type Tool } from 'ai';
import { z, type ZodType, type ZodTypeAny } from 'zod';
import { MCPClient } from './client.js';
import type { MCPToolDefinition } from './client.js';
import type { MCPServerConfig, RemoteMCPServerConfig } from './types.js';
import { isRemoteConfig } from './types.js';

function getServerUrl(cfg: MCPServerConfig): string | null {
  if (isRemoteConfig(cfg)) return (cfg as RemoteMCPServerConfig).url;
  return null;
}

/**
 * Convert a single JSON Schema property definition to a Zod type.
 * Handles the common scalar types returned by MCP servers.
 */
function jsonPropToZod(prop: Record<string, unknown>, required: boolean): ZodTypeAny {
  let base: ZodTypeAny;
  const type = Array.isArray(prop.type) ? prop.type[0] : (prop.type as string | undefined);

  if (type === 'number' || type === 'integer') {
    base = z.number();
  } else if (type === 'boolean') {
    base = z.boolean();
  } else if (type === 'array') {
    base = z.array(z.any());
  } else if (type === 'object') {
    base = z.record(z.string(), z.any());
  } else {
    base = z.string();
  }

  if (prop.description) {
    base = base.describe(prop.description as string);
  }

  return required ? base : base.optional();
}

/**
 * Convert an MCP JSON Schema inputSchema to a Zod object schema.
 * Using real Zod ensures the Bedrock provider (AI SDK v6) handles it correctly.
 * The jsonSchema() helper uses a different serialisation path that Bedrock rejects.
 *
 * Malformed `properties` entries must not become `undefined` Zod fields — Zod 4 then
 * throws when converting to JSON Schema (e.g. reading `shape[k]._zod`).
 */
function mcpSchemaToZod(
  inputSchema: Record<string, unknown> | undefined,
): ZodType<Record<string, unknown>> {
  if (inputSchema == null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return z.object({}) as ZodType<Record<string, unknown>>;
  }

  const rawProps = inputSchema.properties;
  const properties =
    rawProps != null && typeof rawProps === 'object' && !Array.isArray(rawProps)
      ? (rawProps as Record<string, unknown>)
      : {};

  const requiredFields = Array.isArray(inputSchema.required)
    ? (inputSchema.required as string[])
    : [];
  const required = new Set(requiredFields);

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (prop === null || typeof prop !== 'object' || Array.isArray(prop)) {
      shape[key] = z.any().optional();
      // eslint-disable-next-line no-continue -- MCP tool discovery (devtools)
      continue;
    }
    try {
      shape[key] = jsonPropToZod(prop as Record<string, unknown>, required.has(key));
    } catch {
      shape[key] = z.any().optional();
    }
  }

  return z.object(shape) as ZodType<Record<string, unknown>>;
}

function mcpToolToAITool(serverId: string, mcpTool: MCPToolDefinition, mcpClient: MCPClient) {
  const toolName = `mcp__${serverId}__${mcpTool.name}`;
  const description = mcpTool.description ?? `MCP tool ${mcpTool.name} from server ${serverId}`;

  // Convert MCP JSON Schema to real Zod — the only path Bedrock handles reliably.
  const inputSchema: ZodType<Record<string, unknown>> = mcpSchemaToZod(
    mcpTool.inputSchema as Record<string, unknown> | undefined,
  );

  return {
    name: toolName,
    tool: tool({
      description,
      inputSchema,
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
): Promise<{ tools: Record<string, Tool>; clients: MCPClient[] }> {
  const tools: Record<string, Tool> = {};
  const clients: MCPClient[] = [];

  const entries = Object.entries(mcpConfig.mcpServers);

  await Promise.all(
    entries.map(async ([serverId, config]) => {
      const url = getServerUrl(config);
      if (!url) {
        console.log(`MCP server ${serverId}: no reachable URL, skipping`);
        return;
      }

      const remoteHeaders = isRemoteConfig(config)
        ? ((config as RemoteMCPServerConfig).headers ?? {})
        : {};
      const serverHeaders = {
        ...(options?.headers ?? {}),
        ...remoteHeaders,
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
          try {
            const { name, tool: aiTool } = mcpToolToAITool(serverId, mcpTool, client);
            tools[name] = aiTool;
          } catch {
            /* skip tools with unusable schemas */
          }
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
