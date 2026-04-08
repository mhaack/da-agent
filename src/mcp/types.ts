/**
 * MCP (Model Context Protocol) server configuration types.
 *
 * Supports stdio and remote (HTTP/SSE) transports.
 */

export interface StdioMCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface RemoteMCPServerConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type MCPServerConfig = StdioMCPServerConfig | RemoteMCPServerConfig;

/**
 * Configuration for a built-in MCP server that is always added to every chat request.
 * `type`         — transport type ('http' or 'sse').
 * `sendImsToken` — forward the user's IMS Bearer token in the Authorization header.
 * `apiKey`       — static API key to send as x-api-key (omitted when undefined).
 * `instructions` — additional prompt instructions appended to the system prompt.
 */
export interface BuiltInMCPServerConfig {
  type: 'http' | 'sse';
  url: string;
  sendImsToken?: boolean;
  instructions?: string;
}

export function isStdioConfig(config: MCPServerConfig): config is StdioMCPServerConfig {
  return 'command' in config && !('type' in config);
}

export function isRemoteConfig(config: MCPServerConfig): config is RemoteMCPServerConfig {
  return 'type' in config && (config.type === 'http' || config.type === 'sse');
}
