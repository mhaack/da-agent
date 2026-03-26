import { describe, it, expect } from 'vitest';
import {
  loadSkillsIndex,
  loadSkillContent,
  saveSkillContent,
} from '../../src/skills/loader.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';

/**
 * The da-admin list API returns a flat array of { name, path, ext?, lastModified? }.
 * DAAdminClient.listSources types this as DAListSourcesResponse, but at runtime
 * the shape is a plain array. The mock mirrors this real behaviour.
 */
type ListItem = { name: string; path: string; ext?: string };

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

// ---------------------------------------------------------------------------
// loadSkillsIndex
// ---------------------------------------------------------------------------

describe('loadSkillsIndex', () => {
  it('returns skills from site-level .da/skills/', async () => {
    const client = mockClient({
      lists: {
        'mysite/.da/skills': [
          { name: 'brand-voice', path: '/org/mysite/.da/skills/brand-voice.md', ext: 'md' },
          { name: 'seo-checklist', path: '/org/mysite/.da/skills/seo-checklist.md', ext: 'md' },
        ],
      },
      sources: {
        'mysite/.da/skills/brand-voice.md': '# Brand Voice\n\nUse formal tone.',
        'mysite/.da/skills/seo-checklist.md': '# SEO Checklist\n\n1. Meta tags',
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.source).toBe('site');
    expect(index.skills).toHaveLength(2);
    expect(index.skills[0]).toEqual({ id: 'brand-voice', title: 'Brand Voice' });
    expect(index.skills[1]).toEqual({ id: 'seo-checklist', title: 'SEO Checklist' });
  });

  it('falls back to org-level when site has no skills', async () => {
    const client = mockClient({
      lists: {
        '.da/skills': [
          { name: 'org-skill', path: '/org/.da/skills/org-skill.md', ext: 'md' },
        ],
      },
      sources: {
        '.da/skills/org-skill.md': '# Org Skill\n\nShared across sites.',
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.source).toBe('org');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0].id).toBe('org-skill');
    expect(index.skills[0].title).toBe('Org Skill');
  });

  it('returns none when no skills exist at any level', async () => {
    const client = mockClient({});
    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.source).toBe('none');
    expect(index.skills).toHaveLength(0);
  });

  it('filters out non-md files', async () => {
    const client = mockClient({
      lists: {
        'mysite/.da/skills': [
          { name: 'brand-voice', path: '/org/mysite/.da/skills/brand-voice.md', ext: 'md' },
          { name: 'config', path: '/org/mysite/.da/skills/config.json', ext: 'json' },
          { name: 'readme', path: '/org/mysite/.da/skills/readme.txt', ext: 'txt' },
        ],
      },
      sources: {
        'mysite/.da/skills/brand-voice.md': '# Brand Voice\n\nGuidelines.',
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0].id).toBe('brand-voice');
  });

  it('uses first non-empty line as title when no heading', async () => {
    const client = mockClient({
      lists: {
        'mysite/.da/skills': [
          { name: 'plain', path: '/org/mysite/.da/skills/plain.md', ext: 'md' },
        ],
      },
      sources: {
        'mysite/.da/skills/plain.md': '\nJust a paragraph without heading.',
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills[0].title).toBe('Just a paragraph without heading.');
  });

  it('uses skill id as title fallback when content fails to load', async () => {
    const client = mockClient({
      lists: {
        'mysite/.da/skills': [
          { name: 'broken', path: '/org/mysite/.da/skills/broken.md', ext: 'md' },
        ],
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]).toEqual({ id: 'broken', title: 'broken' });
  });
});

// ---------------------------------------------------------------------------
// loadSkillContent
// ---------------------------------------------------------------------------

describe('loadSkillContent', () => {
  it('loads site-level skill content', async () => {
    const client = mockClient({
      sources: {
        'mysite/.da/skills/brand-voice.md': '# Brand Voice\n\nBe concise.',
      },
    });

    const content = await loadSkillContent(client, 'org', 'mysite', 'brand-voice');
    expect(content).toBe('# Brand Voice\n\nBe concise.');
  });

  it('falls back to org-level when site skill not found', async () => {
    const client = mockClient({
      sources: {
        '.da/skills/shared-skill.md': '# Shared\n\nOrg-wide instructions.',
      },
    });

    const content = await loadSkillContent(client, 'org', 'mysite', 'shared-skill');
    expect(content).toBe('# Shared\n\nOrg-wide instructions.');
  });

  it('returns null when skill not found anywhere', async () => {
    const client = mockClient({});
    const content = await loadSkillContent(client, 'org', 'mysite', 'nonexistent');
    expect(content).toBeNull();
  });

  it('handles .md extension in skillId gracefully', async () => {
    const client = mockClient({
      sources: {
        'mysite/.da/skills/test.md': '# Test',
      },
    });

    const content = await loadSkillContent(client, 'org', 'mysite', 'test.md');
    expect(content).toBe('# Test');
  });
});

// ---------------------------------------------------------------------------
// saveSkillContent
// ---------------------------------------------------------------------------

describe('saveSkillContent', () => {
  it('saves a skill successfully', async () => {
    const client = mockClient({ createResult: { success: true } });
    const result = await saveSkillContent(client, 'org', 'mysite', 'new-skill', '# New\n\nContent');
    expect(result.success).toBe(true);
  });

  it('returns error when save fails', async () => {
    const client = {
      createSource: async () => { throw new Error('Permission denied'); },
    } as unknown as DAAdminClient;

    const result = await saveSkillContent(client, 'org', 'mysite', 'fail-skill', '# Fail');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
  });
});
