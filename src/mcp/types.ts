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

export function isStdioConfig(config: MCPServerConfig): config is StdioMCPServerConfig {
  return 'command' in config && !('type' in config);
}

export function isRemoteConfig(config: MCPServerConfig): config is RemoteMCPServerConfig {
  return 'type' in config && (config.type === 'http' || config.type === 'sse');
}
