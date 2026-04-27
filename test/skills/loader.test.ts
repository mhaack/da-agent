import { describe, it, expect } from 'vitest';
import { loadSkillsIndex, loadSkillContent, saveSkillContent } from '../../src/skills/loader.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';

function mockClient(opts: {
  configBySite?: Record<string, Record<string, unknown>>;
  /** Map of "org/site/path" → file content for getSource */
  files?: Record<string, string>;
  /** Array of DASource items returned by listSources for .da/skills/ */
  skillFiles?: Array<{ name: string; path: string; ext: string }>;
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
    listSources: async () => opts.skillFiles ?? [],
    getSource: async (_org: string, _site: string, path: string) => {
      const key = path;
      const content = opts.files?.[key];
      if (content === undefined) throw Object.assign(new Error('not found'), { status: 404 });
      return content;
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
      listSources: async () => {
        throw new Error('network');
      },
      getSource: async () => {
        throw new Error('network');
      },
    } as unknown as DAAdminClient;
    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.source).toBe('none');
    expect(index.skills).toHaveLength(0);
  });

  it('discovers .md-only skills with no config entry', async () => {
    const client = mockClient({
      configBySite: { mysite: {} },
      skillFiles: [{ name: 'orphan-skill', path: '/.da/skills/orphan-skill.md', ext: 'md' }],
      files: { '.da/skills/orphan-skill.md': '# Orphan Skill\n\nI exist only as a file.' },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]).toEqual({ id: 'orphan-skill', title: 'Orphan Skill' });
    expect(index.source).toBe('site');
  });

  it('merges config rows with .md files, preferring .md body', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [
              { key: 'shared', content: '# OLD title\n\nStale config body.' },
              { key: 'config-only', content: '# Config Only\n\nNo file.' },
            ],
          },
        },
      },
      skillFiles: [
        { name: 'shared', path: '/.da/skills/shared.md', ext: 'md' },
        { name: 'file-only', path: '/.da/skills/file-only.md', ext: 'md' },
      ],
      files: {
        '.da/skills/shared.md': '# Updated Title\n\nFresh file body.',
        '.da/skills/file-only.md': '# File Only\n\nOrphan.',
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(3);
    const ids = index.skills.map((s) => s.id);
    expect(ids).toContain('shared');
    expect(ids).toContain('config-only');
    expect(ids).toContain('file-only');
    const shared = index.skills.find((s) => s.id === 'shared');
    expect(shared?.title).toBe('Updated Title');
  });
});

// ---------------------------------------------------------------------------
// loadSkillContent
// ---------------------------------------------------------------------------

describe('loadSkillContent', () => {
  it('prefers .md file over config sheet', async () => {
    const client = mockClient({
      configBySite: {
        mysite: {
          skills: {
            data: [{ key: 'brand-voice', content: '# Stale\n\nOld.' }],
          },
        },
      },
      files: { '.da/skills/brand-voice.md': '# Brand Voice\n\nBe concise.' },
    });

    const content = await loadSkillContent(client, 'org', 'mysite', 'brand-voice');
    expect(content).toBe('# Brand Voice\n\nBe concise.');
  });

  it('falls back to config when .md file missing', async () => {
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

  it('returns null when skill not in sheet and no file', async () => {
    const client = mockClient({ configBySite: { mysite: { skills: { data: [] } } } });
    const content = await loadSkillContent(client, 'org', 'mysite', 'nonexistent');
    expect(content).toBeNull();
  });

  it('returns null for draft skills even if file exists', async () => {
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

  it('returns .md-only skill content (no config entry)', async () => {
    const client = mockClient({
      configBySite: { mysite: {} },
      files: { '.da/skills/orphan.md': '# Orphan\n\nHello.' },
    });
    const content = await loadSkillContent(client, 'org', 'mysite', 'orphan');
    expect(content).toBe('# Orphan\n\nHello.');
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
