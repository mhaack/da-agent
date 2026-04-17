import { describe, it, expect } from 'vitest';
import { loadSkillsIndex, loadSkillContent, saveSkillContent } from '../../src/skills/loader.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';

function mockClient(opts: {
  configBySite?: Record<string, Record<string, unknown>>;
  saveError?: Error;
  listSourcesImpl?: (org: string, site: string, path: string) => Promise<unknown>;
  getSourceImpl?: (org: string, site: string, path: string) => Promise<{ content: string }>;
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
    listSources:
      opts.listSourcesImpl ??
      (async () => []),
    getSource:
      opts.getSourceImpl ??
      (async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      }),
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
    expect(index.skills.map((s) => s.id).sort()).toEqual(['brand-voice', 'seo-checklist']);
    expect(index.skills.find((s) => s.id === 'brand-voice')).toEqual({
      id: 'brand-voice',
      title: 'Brand Voice',
    });
  });

  it('merges /.da/skills/*.md when sheet skills exist', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [{ key: 'sheet-only', content: '# Sheet\n\nok' }],
          },
        },
      },
      listSourcesImpl: async () => [
        { name: 'from-repo', ext: 'md', path: '.da/skills/from-repo.md' },
      ],
      getSourceImpl: async (_o, _s, path) => {
        if (path.endsWith('from-repo.md')) return { content: '# Repo Skill\n\nOnly in file.' };
        throw Object.assign(new Error('nf'), { status: 404 });
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills.map((s) => s.id).sort()).toEqual(['from-repo', 'sheet-only']);
  });

  it('includes md-only skills when sheet has no row for that id', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: { data: [] },
        },
      },
      listSourcesImpl: async () => [{ name: 'orphan', ext: 'md' }],
      getSourceImpl: async (_o, _s, path) => {
        if (path.includes('orphan.md')) return { content: '# Orphan\n\nBody' };
        throw Object.assign(new Error('nf'), { status: 404 });
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]).toEqual({ id: 'orphan', title: 'Orphan' });
  });

  it('omits draft skills from the index even when a repo file exists', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [{ key: 'wip', content: '# WIP\n\nnot ready', status: 'draft' }],
          },
        },
      },
      listSourcesImpl: async () => [{ name: 'wip', ext: 'md' }],
      getSourceImpl: async () => ({ content: '# Should not appear\n\nx' }),
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(0);
    expect(index.source).toBe('none');
  });

  it('omits draft skills from the index when draft has only sheet entry', async () => {
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

  it('returns none when sheet missing or empty and listSources yields nothing', async () => {
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
      listSources: async () => [],
      getSource: async () => ({ content: '' }),
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
  it('loads skill markdown by id from sheet', async () => {
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

  it('loads skill body from /.da/skills/{id}.md when sheet has no row', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: { data: [] },
        },
      },
      getSourceImpl: async (_o, _s, path) => {
        if (path === '.da/skills/repo-only.md') return { content: '# Repo Only\n\nHello.' };
        throw Object.assign(new Error('nf'), { status: 404 });
      },
    });

    const content = await loadSkillContent(client, 'org', 'mysite', 'repo-only');
    expect(content).toBe('# Repo Only\n\nHello.');
  });

  it('prefers repo markdown over sheet when both exist', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [{ key: 'merged', content: '# From Sheet\n\nOld.' }],
          },
        },
      },
      getSourceImpl: async (_o, _s, path) => {
        if (path === '.da/skills/merged.md') return { content: '# From File\n\nNew.' };
        throw Object.assign(new Error('nf'), { status: 404 });
      },
    });

    const content = await loadSkillContent(client, 'org', 'mysite', 'merged');
    expect(content).toBe('# From File\n\nNew.');
  });

  it('returns null when skill not in sheet and no md file', async () => {
    const client = mockClient({
      configBySite: { mysite: { skills: { data: [] } } },
    });
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
      getSourceImpl: async () => ({ content: '# File\n\nShould not load' }),
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
