/**
 * MCP (Model Context Protocol) server configuration types.
 *
 * These mirror the standard mcpServers value shape used by Claude Agent SDK /
 * Claude Code, supporting stdio and remote (HTTP/SSE) transports.
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

export interface MCPDiscoveryWarning {
  serverId: string;
  message: string;
}

export interface MCPServerStatus {
  id: string;
  sourcePath: string;
  status: 'ok' | 'reachable' | 'unreachable' | 'error';
  transport?: 'stdio' | 'http' | 'sse';
  endpoint?: string;
  description?: string;
  statusDetail?: string;
}

/**
 * Normalized discovery cache written to `.da/discovered-mcp.json`.
 */
export interface DiscoveredMCP {
  readAt: string;
  mcpServers: Record<string, MCPServerConfig>;
  warnings: MCPDiscoveryWarning[];
  servers: MCPServerStatus[];
}

/**
 * Result of merging system (platform) and repo MCP configs.
 */
export interface EffectiveMCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
  toolAllowPatterns: string[];
}

export function isStdioConfig(config: MCPServerConfig): config is StdioMCPServerConfig {
  return 'command' in config && !('type' in config);
}

export function isRemoteConfig(config: MCPServerConfig): config is RemoteMCPServerConfig {
  return 'type' in config && (config.type === 'http' || config.type === 'sse');
}
