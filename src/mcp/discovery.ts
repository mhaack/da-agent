/**
 * MCP Discovery — scan a GitHub repository for MCP server projects,
 * validate them, and produce a normalized overlay that can be merged
 * with the platform's system MCP config.
 *
 * Discovery strategy (in order):
 * 1. List `mcp-servers/` for subdirectories with mcp.json
 * 2. If no mcp.json, infer config from package.json scripts
 * 3. If mcp-servers/ is empty/missing, scan repo root for *-mcp folders
 */

import type { DAAdminClient } from '../da-admin/client.js';
import type {
  MCPServerConfig,
  DiscoveredMCP,
  MCPDiscoveryWarning,
  MCPServerStatus,
  EffectiveMCPConfig,
} from './types.js';
import { isStdioConfig, isRemoteConfig } from './types.js';

const SERVER_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_MCP_JSON_SIZE = 64 * 1024; // 64 KiB
const GITHUB_API = 'https://api.github.com';

const PLATFORM_SERVER_IDS = new Set([
  'playwright',
  'catalyst_ui',
]);

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

interface GitHubItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

async function ghFetch(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'da-agent',
  };
  if (token) headers.Authorization = `token ${token}`;
  return fetch(url, { headers });
}

async function listGitHubDir(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token?: string,
): Promise<GitHubItem[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  try {
    const resp = await ghFetch(url, token);
    if (!resp.ok) return [];
    const data = await resp.json() as any;
    if (!Array.isArray(data)) return [];
    return data.map((item: any) => ({
      name: item.name,
      path: item.path,
      type: item.type === 'dir' ? 'dir' : 'file',
    }));
  } catch {
    return [];
  }
}

async function readGitHubFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token?: string,
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  try {
    const resp = await ghFetch(url, token);
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if (data.encoding === 'base64' && data.content) {
      return atob(data.content.replace(/\n/g, ''));
    }
    if (typeof data.content === 'string') return data.content;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateServerId(id: string): string | null {
  if (!SERVER_ID_RE.test(id)) {
    return `Invalid serverId "${id}": must match ${SERVER_ID_RE}`;
  }
  if (PLATFORM_SERVER_IDS.has(id)) {
    return `Skipped: server id "${id}" reserved by platform MCP`;
  }
  return null;
}

function validateConfig(raw: unknown): { config: MCPServerConfig | null; error: string | null } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: null, error: 'mcp.json must be a JSON object' };
  }

  const obj = raw as Record<string, unknown>;

  if ('type' in obj && (obj.type === 'http' || obj.type === 'sse')) {
    if (typeof obj.url !== 'string' || !obj.url) {
      return { config: null, error: `Remote MCP config (${obj.type}) requires a "url" string` };
    }
    const remote: MCPServerConfig = {
      type: obj.type as 'http' | 'sse',
      url: obj.url,
      ...(obj.headers && typeof obj.headers === 'object' ? { headers: obj.headers as Record<string, string> } : {}),
    };
    return { config: remote, error: null };
  }

  if (typeof obj.command === 'string' && obj.command) {
    const stdio: MCPServerConfig = {
      command: obj.command,
      ...(Array.isArray(obj.args) ? { args: obj.args as string[] } : {}),
      ...(obj.env && typeof obj.env === 'object' ? { env: obj.env as Record<string, string> } : {}),
      ...(typeof obj.cwd === 'string' ? { cwd: obj.cwd } : {}),
    };
    return { config: stdio, error: null };
  }

  return { config: null, error: 'mcp.json must specify either "command" (stdio) or "type"+"url" (remote)' };
}

function inferConfigFromPackageJson(pkgRaw: string): { config: MCPServerConfig | null; error: string | null } {
  let parsed: any;
  try {
    parsed = JSON.parse(pkgRaw);
  } catch {
    return { config: null, error: 'package.json is not valid JSON' };
  }

  const scripts = parsed?.scripts;
  if (!scripts || typeof scripts !== 'object') {
    return { config: null, error: 'package.json has no scripts' };
  }

  const scriptName = typeof scripts.start === 'string' && scripts.start
    ? 'start'
    : (typeof scripts.dev === 'string' && scripts.dev ? 'dev' : null);

  if (!scriptName) {
    return { config: null, error: 'package.json needs a "start" or "dev" script' };
  }

  let command = 'npm';
  const pm = parsed.packageManager;
  if (typeof pm === 'string') {
    if (pm.startsWith('pnpm@')) command = 'pnpm';
    else if (pm.startsWith('yarn@')) command = 'yarn';
  }

  return { config: { command, args: ['run', scriptName] }, error: null };
}

function resolveRelativeUrl(
  url: string,
  siteOrigin: string | undefined,
): { resolved: string; error: string | null } {
  try {
    new URL(url);
    return { resolved: url, error: null };
  } catch { /* relative */ }
  if (!siteOrigin) {
    return { resolved: url, error: 'Relative URL requires a configured site origin' };
  }
  try {
    return { resolved: new URL(url, siteOrigin).href, error: null };
  } catch {
    return { resolved: url, error: `Could not resolve "${url}" against "${siteOrigin}"` };
  }
}

// ---------------------------------------------------------------------------
// Process a single server directory
// ---------------------------------------------------------------------------

async function getPackageDescription(
  owner: string,
  repo: string,
  serverPath: string,
  branch: string,
  ghToken?: string,
): Promise<string | undefined> {
  const pkgRaw = await readGitHubFile(owner, repo, `${serverPath}/package.json`, branch, ghToken);
  if (!pkgRaw) return undefined;
  try {
    const pkg = JSON.parse(pkgRaw);
    return typeof pkg.description === 'string' ? pkg.description : undefined;
  } catch {
    return undefined;
  }
}

async function probeRemoteEndpoint(url: string): Promise<{ reachable: boolean; detail: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);
    if (resp.ok || resp.status === 405 || resp.status === 404) {
      return { reachable: true, detail: `Responded ${resp.status}` };
    }
    return { reachable: false, detail: `HTTP ${resp.status} ${resp.statusText}` };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'Timeout (5s)' : (e?.message || 'Connection failed');
    return { reachable: false, detail: msg };
  }
}

async function processServerDir(
  owner: string,
  repo: string,
  serverId: string,
  serverPath: string,
  branch: string,
  mcpServers: Record<string, MCPServerConfig>,
  warnings: MCPDiscoveryWarning[],
  servers: MCPServerStatus[],
  siteOrigin?: string,
  ghToken?: string,
): Promise<void> {
  const pushError = (msg: string, src?: string) => {
    warnings.push({ serverId, message: msg });
    servers.push({
      id: serverId,
      sourcePath: src ?? `${serverPath}/mcp.json`,
      status: 'error',
      statusDetail: msg,
    });
  };

  const idError = validateServerId(serverId);
  if (idError) { pushError(idError); return; }

  // Try reading description from package.json (non-blocking)
  const descriptionPromise = getPackageDescription(owner, repo, serverPath, branch, ghToken);

  let raw = await readGitHubFile(owner, repo, `${serverPath}/mcp.json`, branch, ghToken);
  let configSource = `${serverPath}/mcp.json`;

  if (raw === null) {
    const pkgRaw = await readGitHubFile(owner, repo, `${serverPath}/package.json`, branch, ghToken);
    if (pkgRaw !== null) {
      const { config: inferred, error } = inferConfigFromPackageJson(pkgRaw);
      if (!inferred || error) {
        pushError(`Could not infer from package.json: ${error}`, `${serverPath}/package.json`);
        return;
      }
      raw = JSON.stringify(inferred);
      configSource = `${serverPath}/package.json`;
      warnings.push({ serverId, message: 'Config inferred from package.json scripts' });
    } else {
      pushError(`No mcp.json or package.json in ${serverPath}/`);
      return;
    }
  }

  if (raw.length > MAX_MCP_JSON_SIZE) { pushError('Config exceeds 64 KiB size limit'); return; }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { pushError('mcp.json is not valid JSON'); return; }

  const { config, error } = validateConfig(parsed);
  if (!config || error) { pushError(error ?? 'Unknown validation error'); return; }

  const description = await descriptionPromise;

  if (isRemoteConfig(config)) {
    const { resolved, error: urlError } = resolveRelativeUrl(config.url, siteOrigin);
    if (urlError) { pushError(urlError); return; }
    config.url = resolved;

    const probe = await probeRemoteEndpoint(config.url);
    mcpServers[serverId] = config;
    servers.push({
      id: serverId,
      sourcePath: configSource,
      status: probe.reachable ? 'reachable' : 'unreachable',
      transport: config.type,
      endpoint: config.url,
      description,
      statusDetail: probe.detail,
    });
    return;
  }

  if (isStdioConfig(config)) {
    if (!config.cwd) config.cwd = serverPath;
    mcpServers[serverId] = config;
    servers.push({
      id: serverId,
      sourcePath: configSource,
      status: 'ok',
      transport: 'stdio',
      endpoint: `${config.command} ${(config.args ?? []).join(' ')}`.trim(),
      description,
      statusDetail: 'Valid config (stdio — requires local runtime)',
    });
    return;
  }

  mcpServers[serverId] = config;
  servers.push({ id: serverId, sourcePath: configSource, status: 'ok', description });
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export interface ScanOptions {
  siteOrigin?: string;
  branch?: string;
  githubToken?: string;
}

/**
 * Scan a GitHub repository for MCP server projects.
 *
 * 1. Try `mcp-servers/` subdirectories
 * 2. If empty, scan repo root for folders ending in `-mcp`
 */
export async function scanRepoMCPServers(
  owner: string,
  repo: string,
  options: ScanOptions = {},
): Promise<DiscoveredMCP> {
  const branch = options.branch || 'main';
  const ghToken = options.githubToken;
  const mcpServers: Record<string, MCPServerConfig> = {};
  const warnings: MCPDiscoveryWarning[] = [];
  const servers: MCPServerStatus[] = [];

  // Strategy 1: mcp-servers/ subdirectories
  const mcpItems = await listGitHubDir(owner, repo, 'mcp-servers', branch, ghToken);
  const mcpDirs = mcpItems.filter((item) => item.type === 'dir');

  if (mcpDirs.length > 0) {
    for (const dir of mcpDirs) {
      await processServerDir(owner, repo, dir.name, dir.path, branch, mcpServers, warnings, servers, options.siteOrigin, ghToken);
    }
    return { readAt: new Date().toISOString(), mcpServers, warnings, servers };
  }

  // Strategy 2: repo root *-mcp folders
  const rootItems = await listGitHubDir(owner, repo, '', branch, ghToken);
  const mcpRootDirs = rootItems.filter((item) => item.type === 'dir' && item.name.endsWith('-mcp'));

  if (mcpRootDirs.length > 0) {
    warnings.push({ serverId: '*', message: 'Discovered MCP servers from repo root (*-mcp folders)' });
    for (const dir of mcpRootDirs) {
      await processServerDir(owner, repo, dir.name, dir.path, branch, mcpServers, warnings, servers, options.siteOrigin, ghToken);
    }
    return { readAt: new Date().toISOString(), mcpServers, warnings, servers };
  }

  return {
    readAt: new Date().toISOString(),
    mcpServers,
    warnings: [{ serverId: '*', message: 'No MCP server folders found in mcp-servers/ or repo root' }],
    servers,
  };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export function loadEffectiveMCPConfig(
  systemConfig: Record<string, MCPServerConfig>,
  repoOverlay: DiscoveredMCP | null,
): EffectiveMCPConfig {
  if (!repoOverlay || Object.keys(repoOverlay.mcpServers).length === 0) {
    return {
      mcpServers: { ...systemConfig },
      toolAllowPatterns: Object.keys(systemConfig).map((id) => `mcp__${id}__*`),
    };
  }

  const repoOnlyKeys: Record<string, MCPServerConfig> = {};
  for (const [id, config] of Object.entries(repoOverlay.mcpServers)) {
    if (!(id in systemConfig)) {
      repoOnlyKeys[id] = config;
    }
  }

  const merged: Record<string, MCPServerConfig> = {
    ...repoOnlyKeys,
    ...systemConfig,
  };

  return {
    mcpServers: merged,
    toolAllowPatterns: Object.keys(merged).map((id) => `mcp__${id}__*`),
  };
}

// ---------------------------------------------------------------------------
// Cache I/O via DAAdminClient
// ---------------------------------------------------------------------------

const CACHE_PATH = '.da/discovered-mcp.json';

export async function readDiscoveryCache(
  client: DAAdminClient,
  org: string,
  repo: string,
): Promise<DiscoveredMCP | null> {
  try {
    const source = await client.getSource(org, repo, CACHE_PATH);
    const raw = typeof source === 'string' ? source : (source as any).content;
    return JSON.parse(raw) as DiscoveredMCP;
  } catch {
    return null;
  }
}
