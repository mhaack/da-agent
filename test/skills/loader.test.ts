import { describe, it, expect } from 'vitest';
import { loadSkillsIndex, loadSkillContent, saveSkillContent } from '../../src/skills/loader.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';

function mockClient(opts: {
  configBySite?: Record<string, Record<string, unknown>>;
  saveError?: Error;
}): DAAdminClient {
  return {
    getSiteConfig: async (_org: string, site: string) => {
      const cfg = opts.configBySite?.[site];
      if (!cfg) throw Object.assign(new Error('not found'), { status: 404 });
      return cfg;
    },
    saveSiteConfig: async () => {
      if (opts.saveError) throw opts.saveError;
      return { ok: true };
    },
  } as unknown as DAAdminClient;
}

// ---------------------------------------------------------------------------
// loadSkillsIndex
// ---------------------------------------------------------------------------

describe('loadSkillsIndex', () => {
  it('returns skills from config skills sheet', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [
              { key: 'brand-voice', content: '# Brand Voice\n\nUse formal tone.' },
              { key: 'seo-checklist', content: '# SEO Checklist\n\n1. Meta tags' },
            ],
            total: 2,
          },
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.source).toBe('site');
    expect(index.skills).toHaveLength(2);
    expect(index.skills[0]).toEqual({ id: 'brand-voice', title: 'Brand Voice' });
    expect(index.skills[1]).toEqual({ id: 'seo-checklist', title: 'SEO Checklist' });
  });

  it('omits draft skills from the index', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [
              { key: 'live', content: '# Live\n\nok' },
              { key: 'wip', content: '# WIP\n\nnot ready', status: 'draft' },
            ],
            total: 2,
          },
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]?.id).toBe('live');
  });

  it('returns none when sheet missing or empty', async () => {
    const client = mockClient({ configBySite: { mysite: {} } });
    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.source).toBe('none');
    expect(index.skills).toHaveLength(0);
  });

  it('returns none when getSiteConfig fails', async () => {
    const client = {
      getSiteConfig: async () => {
        throw new Error('network');
      },
    } as unknown as DAAdminClient;
    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.source).toBe('none');
    expect(index.skills).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadSkillContent
// ---------------------------------------------------------------------------

describe('loadSkillContent', () => {
  it('loads skill markdown by id', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [{ key: 'brand-voice', content: '# Brand Voice\n\nBe concise.' }],
          },
        },
      },
    });

    const content = await loadSkillContent(client, 'org', 'mysite', 'brand-voice');
    expect(content).toBe('# Brand Voice\n\nBe concise.');
  });

  it('returns null when skill not in sheet', async () => {
    const client = mockClient({ configBySite: { mysite: { skills: { data: [] } } } });
    const content = await loadSkillContent(client, 'org', 'mysite', 'nonexistent');
    expect(content).toBeNull();
  });

  it('returns null for draft skills', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [{ key: 'wip', content: '# WIP\n\nx', status: 'draft' }],
          },
        },
      },
    });
    const content = await loadSkillContent(client, 'org', 'mysite', 'wip');
    expect(content).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// saveSkillContent
// ---------------------------------------------------------------------------

describe('saveSkillContent', () => {
  it('merges into skills sheet', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [{ key: 'a', content: 'x' }],
            total: 1,
            limit: 1000,
            offset: 0,
          },
          'mcp-servers': { data: [], total: 0 },
        },
      },
    });

    const result = await saveSkillContent(client, 'org', 'mysite', 'new-skill', '# New\n\nContent');
    expect(result.success).toBe(true);
  });

  it('returns error when save fails', async () => {
    const client = mockClient({
      configBySite: {
        mysite: { skills: { data: [], total: 0, limit: 1000, offset: 0 } },
      },
      saveError: new Error('Permission denied'),
    });

    const result = await saveSkillContent(client, 'org', 'mysite', 'fail-skill', '# Fail');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
  });
});
