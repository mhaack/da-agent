import { describe, it, expect } from 'vitest';
import {
  listAgentPresets,
  loadAgentPreset,
  saveAgentPreset,
} from '../../src/agents/loader.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';
import type { AgentPreset } from '../../src/agents/loader.js';

type ListItem = { name: string; path: string; ext?: string };

const VALID_PRESET: AgentPreset = {
  name: 'SEO Agent',
  description: 'Optimizes content for search engines',
  systemPrompt: 'You are an SEO specialist.',
  skills: ['seo-checklist', 'meta-tags'],
  mcpServers: ['analytics-api'],
};

function mockClient(opts: {
  lists?: Record<string, ListItem[]>;
  sources?: Record<string, string>;
  createResult?: { success: boolean };
}): DAAdminClient {
  return {
    listSources: async (_org: string, repo: string, path: string) => {
      const key = `${repo}/${path}`;
      const items = opts.lists?.[key];
      if (!items) throw new Error(`Not found: ${key}`);
      return items as any;
    },
    getSource: async (_org: string, repo: string, path: string) => {
      const key = `${repo}/${path}`;
      const raw = opts.sources?.[key];
      if (raw === undefined) throw new Error(`Not found: ${key}`);
      return raw as any;
    },
    createSource: async () => opts.createResult ?? { success: true },
  } as unknown as DAAdminClient;
}

describe('listAgentPresets', () => {
  it('lists site-level agent presets', async () => {
    const client = mockClient({
      lists: {
        'mysite/.da/agents': [
          { name: 'seo-agent', path: '/org/mysite/.da/agents/seo-agent.json', ext: 'json' },
        ],
      },
      sources: {
        'mysite/.da/agents/seo-agent.json': JSON.stringify(VALID_PRESET),
      },
    });

    const result = await listAgentPresets(client, 'org', 'mysite');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('seo-agent');
    expect(result[0].name).toBe('SEO Agent');
    expect(result[0].description).toBe('Optimizes content for search engines');
  });

  it('returns empty array when no agents exist', async () => {
    const client = mockClient({});
    const result = await listAgentPresets(client, 'org', 'mysite');
    expect(result).toHaveLength(0);
  });

  it('filters non-json files', async () => {
    const client = mockClient({
      lists: {
        'mysite/.da/agents': [
          { name: 'seo-agent', path: '/org/mysite/.da/agents/seo-agent.json', ext: 'json' },
          { name: 'readme', path: '/org/mysite/.da/agents/readme.md', ext: 'md' },
        ],
      },
      sources: {
        'mysite/.da/agents/seo-agent.json': JSON.stringify(VALID_PRESET),
      },
    });

    const result = await listAgentPresets(client, 'org', 'mysite');
    expect(result).toHaveLength(1);
  });

  it('uses id as fallback name when content fails to load', async () => {
    const client = mockClient({
      lists: {
        'mysite/.da/agents': [
          { name: 'broken', path: '/org/mysite/.da/agents/broken.json', ext: 'json' },
        ],
      },
    });

    const result = await listAgentPresets(client, 'org', 'mysite');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 'broken', name: 'broken', description: '' });
  });
});

describe('loadAgentPreset', () => {
  it('loads a site-level agent preset', async () => {
    const client = mockClient({
      sources: {
        'mysite/.da/agents/seo-agent.json': JSON.stringify(VALID_PRESET),
      },
    });

    const preset = await loadAgentPreset(client, 'org', 'mysite', 'seo-agent');
    expect(preset).not.toBeNull();
    expect(preset!.name).toBe('SEO Agent');
    expect(preset!.skills).toEqual(['seo-checklist', 'meta-tags']);
    expect(preset!.mcpServers).toEqual(['analytics-api']);
  });

  it('falls back to org-level', async () => {
    const client = mockClient({
      sources: {
        '.da/agents/shared-agent.json': JSON.stringify({ ...VALID_PRESET, name: 'Shared' }),
      },
    });

    const preset = await loadAgentPreset(client, 'org', 'mysite', 'shared-agent');
    expect(preset).not.toBeNull();
    expect(preset!.name).toBe('Shared');
  });

  it('returns null when preset not found', async () => {
    const client = mockClient({});
    const preset = await loadAgentPreset(client, 'org', 'mysite', 'nonexistent');
    expect(preset).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    const client = mockClient({
      sources: {
        'mysite/.da/agents/bad.json': 'not-json',
      },
    });

    const preset = await loadAgentPreset(client, 'org', 'mysite', 'bad');
    expect(preset).toBeNull();
  });

  it('returns null when name field is missing', async () => {
    const client = mockClient({
      sources: {
        'mysite/.da/agents/no-name.json': JSON.stringify({ description: 'test' }),
      },
    });

    const preset = await loadAgentPreset(client, 'org', 'mysite', 'no-name');
    expect(preset).toBeNull();
  });

  it('defaults missing arrays to empty', async () => {
    const client = mockClient({
      sources: {
        'mysite/.da/agents/minimal.json': JSON.stringify({ name: 'Minimal' }),
      },
    });

    const preset = await loadAgentPreset(client, 'org', 'mysite', 'minimal');
    expect(preset!.skills).toEqual([]);
    expect(preset!.mcpServers).toEqual([]);
    expect(preset!.systemPrompt).toBe('');
  });
});

describe('saveAgentPreset', () => {
  it('saves successfully', async () => {
    const client = mockClient({ createResult: { success: true } });
    const result = await saveAgentPreset(client, 'org', 'mysite', 'test-agent', VALID_PRESET);
    expect(result.success).toBe(true);
  });

  it('returns error on failure', async () => {
    const client = {
      createSource: async () => { throw new Error('Forbidden'); },
    } as unknown as DAAdminClient;

    const result = await saveAgentPreset(client, 'org', 'mysite', 'fail', VALID_PRESET);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Forbidden');
  });
});
