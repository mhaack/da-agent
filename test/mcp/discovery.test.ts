import { describe, it, expect } from 'vitest';
import {
  scanRepoMCPServers,
  loadEffectiveMCPConfig,
  readDiscoveryCache,
} from '../../src/mcp/discovery.js';
import type { DiscoveredMCP, MCPServerConfig } from '../../src/mcp/types.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';

/**
 * Build a mock DAAdminClient with controllable listSources / getSource.
 */
function mockClient(opts: {
  listResult?: { sources: Array<{ name: string; path: string; type: string }> };
  listError?: boolean;
  sources?: Record<string, string>;
}): DAAdminClient {
  return {
    listSources: async () => {
      if (opts.listError) throw new Error('Not found');
      return opts.listResult ?? { sources: [] };
    },
    getSource: async (_org: string, _repo: string, path: string) => {
      const raw = opts.sources?.[path];
      if (!raw) throw new Error(`Not found: ${path}`);
      return { content: raw, path };
    },
  } as unknown as DAAdminClient;
}

// ---------------------------------------------------------------------------
// scanRepoMCPServers
// ---------------------------------------------------------------------------

describe('scanRepoMCPServers', () => {
  it('returns empty with warning when mcp-servers/ not found', async () => {
    const client = mockClient({ listError: true });
    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(Object.keys(result.mcpServers)).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns empty with warning when no subdirectories', async () => {
    const client = mockClient({
      listResult: { sources: [{ name: 'readme.md', path: '/readme.md', type: 'file' }] },
    });
    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(Object.keys(result.mcpServers)).toHaveLength(0);
    expect(result.warnings[0].message).toContain('no subdirectories');
  });

  it('discovers a valid stdio server', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'acme-tools', path: '/mcp-servers/acme-tools', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/acme-tools/mcp.json': JSON.stringify({
          command: 'node',
          args: ['./dist/server.js'],
        }),
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(result.mcpServers['acme-tools']).toBeDefined();
    expect(result.mcpServers['acme-tools']).toHaveProperty('command', 'node');
    expect(result.servers[0].status).toBe('ok');
  });

  it('sets default cwd for stdio servers without explicit cwd', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'my-server', path: '/mcp-servers/my-server', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/my-server/mcp.json': JSON.stringify({ command: 'python3', args: ['-m', 'srv'] }),
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite', {
      workspacePath: '/workspace/root',
    });
    const config = result.mcpServers['my-server'] as { cwd?: string };
    expect(config.cwd).toBe('/workspace/root/mcp-servers/my-server');
  });

  it('preserves explicit cwd', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'my-server', path: '/mcp-servers/my-server', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/my-server/mcp.json': JSON.stringify({
          command: 'node',
          args: ['index.js'],
          cwd: '/custom/path',
        }),
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    const config = result.mcpServers['my-server'] as { cwd?: string };
    expect(config.cwd).toBe('/custom/path');
  });

  it('discovers a valid remote SSE server', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'remote-api', path: '/mcp-servers/remote-api', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/remote-api/mcp.json': JSON.stringify({
          type: 'sse',
          url: 'https://example.com/mcp',
        }),
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    const config = result.mcpServers['remote-api'] as { type: string; url: string };
    expect(config.type).toBe('sse');
    expect(config.url).toBe('https://example.com/mcp');
  });

  it('resolves relative URL with siteOrigin', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'rel-api', path: '/mcp-servers/rel-api', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/rel-api/mcp.json': JSON.stringify({
          type: 'http',
          url: '/api/mcp',
        }),
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite', {
      siteOrigin: 'https://mysite.example.com',
    });
    const config = result.mcpServers['rel-api'] as { url: string };
    expect(config.url).toBe('https://mysite.example.com/api/mcp');
  });

  it('errors on relative URL without siteOrigin', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'rel-api', path: '/mcp-servers/rel-api', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/rel-api/mcp.json': JSON.stringify({
          type: 'http',
          url: '/api/mcp',
        }),
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(result.mcpServers['rel-api']).toBeUndefined();
    expect(result.warnings.find((w) => w.serverId === 'rel-api')).toBeDefined();
  });

  it('skips reserved platform server id', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'playwright', path: '/mcp-servers/playwright', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/playwright/mcp.json': JSON.stringify({ command: 'npx', args: ['playwright-server'] }),
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(result.mcpServers['playwright']).toBeUndefined();
    const warning = result.warnings.find((w) => w.serverId === 'playwright');
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('reserved');
  });

  it('skips invalid serverId', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'has spaces', path: '/mcp-servers/has spaces', type: 'directory' },
        ],
      },
      sources: {},
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(result.mcpServers['has spaces']).toBeUndefined();
    expect(result.warnings[0].message).toContain('must match');
  });

  it('skips folders with missing mcp.json', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'no-config', path: '/mcp-servers/no-config', type: 'directory' },
        ],
      },
      sources: {},
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(Object.keys(result.mcpServers)).toHaveLength(0);
    expect(result.servers[0].status).toBe('error');
  });

  it('skips folders with invalid JSON', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'bad-json', path: '/mcp-servers/bad-json', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/bad-json/mcp.json': '{ broken json',
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(Object.keys(result.mcpServers)).toHaveLength(0);
    const warning = result.warnings.find((w) => w.serverId === 'bad-json');
    expect(warning!.message).toContain('not valid JSON');
  });

  it('skips folders with invalid config shape', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'bad-shape', path: '/mcp-servers/bad-shape', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/bad-shape/mcp.json': JSON.stringify({ foo: 'bar' }),
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(Object.keys(result.mcpServers)).toHaveLength(0);
  });

  it('handles mixed success and failure across multiple folders', async () => {
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'good-one', path: '/mcp-servers/good-one', type: 'directory' },
          { name: 'bad-one', path: '/mcp-servers/bad-one', type: 'directory' },
          { name: 'playwright', path: '/mcp-servers/playwright', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/good-one/mcp.json': JSON.stringify({ command: 'node', args: ['server.js'] }),
        'mcp-servers/bad-one/mcp.json': '{}',
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(Object.keys(result.mcpServers)).toHaveLength(1);
    expect(result.mcpServers['good-one']).toBeDefined();
    expect(result.warnings).toHaveLength(2);
    expect(result.servers.filter((s) => s.status === 'ok')).toHaveLength(1);
    expect(result.servers.filter((s) => s.status === 'error')).toHaveLength(2);
  });

  it('rejects mcp.json exceeding 64 KiB', async () => {
    const largeContent = JSON.stringify({ command: 'node', args: ['x'.repeat(70000)] });
    const client = mockClient({
      listResult: {
        sources: [
          { name: 'large', path: '/mcp-servers/large', type: 'directory' },
        ],
      },
      sources: {
        'mcp-servers/large/mcp.json': largeContent,
      },
    });

    const result = await scanRepoMCPServers(client, 'adobe', 'mysite');
    expect(result.mcpServers['large']).toBeUndefined();
    expect(result.warnings[0].message).toContain('64 KiB');
  });
});

// ---------------------------------------------------------------------------
// loadEffectiveMCPConfig
// ---------------------------------------------------------------------------

describe('loadEffectiveMCPConfig', () => {
  it('returns system config unchanged when no overlay', () => {
    const systemConfig: Record<string, MCPServerConfig> = {
      'system-server': { command: 'node', args: ['sys.js'] },
    };
    const result = loadEffectiveMCPConfig(systemConfig, null);
    expect(result.mcpServers).toEqual(systemConfig);
    expect(result.toolAllowPatterns).toContain('mcp__system-server__*');
  });

  it('returns system config unchanged when overlay has empty mcpServers', () => {
    const systemConfig: Record<string, MCPServerConfig> = {
      'system-server': { command: 'node', args: ['sys.js'] },
    };
    const overlay: DiscoveredMCP = {
      readAt: '2026-01-01T00:00:00Z',
      mcpServers: {},
      warnings: [],
      servers: [],
    };
    const result = loadEffectiveMCPConfig(systemConfig, overlay);
    expect(result.mcpServers).toEqual(systemConfig);
  });

  it('merges repo servers with system servers (system wins on collision)', () => {
    const systemConfig: Record<string, MCPServerConfig> = {
      'sys-only': { command: 'node', args: ['sys.js'] },
      'colliding': { command: 'node', args: ['system-version.js'] },
    };
    const overlay: DiscoveredMCP = {
      readAt: '2026-01-01T00:00:00Z',
      mcpServers: {
        'repo-only': { command: 'python3', args: ['repo.py'] },
        'colliding': { command: 'python3', args: ['repo-version.py'] },
      },
      warnings: [],
      servers: [],
    };

    const result = loadEffectiveMCPConfig(systemConfig, overlay);
    expect(Object.keys(result.mcpServers)).toHaveLength(3);
    expect(result.mcpServers['sys-only']).toEqual(systemConfig['sys-only']);
    expect(result.mcpServers['repo-only']).toEqual(overlay.mcpServers['repo-only']);
    // System wins on collision
    expect((result.mcpServers['colliding'] as { args: string[] }).args[0]).toBe('system-version.js');
  });

  it('builds tool allow patterns for all merged servers', () => {
    const systemConfig: Record<string, MCPServerConfig> = {
      'sys': { command: 'node', args: [] },
    };
    const overlay: DiscoveredMCP = {
      readAt: '2026-01-01T00:00:00Z',
      mcpServers: {
        'repo': { type: 'http', url: 'https://example.com' },
      },
      warnings: [],
      servers: [],
    };

    const result = loadEffectiveMCPConfig(systemConfig, overlay);
    expect(result.toolAllowPatterns).toContain('mcp__sys__*');
    expect(result.toolAllowPatterns).toContain('mcp__repo__*');
  });

  it('returns empty config when both system and overlay are empty', () => {
    const result = loadEffectiveMCPConfig({}, null);
    expect(Object.keys(result.mcpServers)).toHaveLength(0);
    expect(result.toolAllowPatterns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readDiscoveryCache
// ---------------------------------------------------------------------------

describe('readDiscoveryCache', () => {
  it('returns null when cache does not exist', async () => {
    const client = mockClient({ sources: {} });
    const result = await readDiscoveryCache(client, 'adobe', 'mysite');
    expect(result).toBeNull();
  });

  it('returns parsed cache when it exists', async () => {
    const cached: DiscoveredMCP = {
      readAt: '2026-01-01T00:00:00Z',
      mcpServers: { foo: { command: 'node', args: ['foo.js'] } },
      warnings: [],
      servers: [{ id: 'foo', sourcePath: 'mcp-servers/foo/mcp.json', status: 'ok' }],
    };
    const client = mockClient({
      sources: { '.da/discovered-mcp.json': JSON.stringify(cached) },
    });
    const result = await readDiscoveryCache(client, 'adobe', 'mysite');
    expect(result).toEqual(cached);
  });
});
