/**
 * Characterization tests — frozen behavior of existing skill load/read/save for PLG customers.
 * Do NOT change assertions without a deliberate migration decision.
 *
 * Cross-reference: many behaviors are already asserted in:
 *   - test/skills/folder-loader.test.ts  (loadSkillsIndexFromFolders, loadSkillBodyFromFolder)
 *   - test/skills/loader.test.ts          (loadSkillsIndex, loadSkillContent, saveSkillContent)
 *
 * This file covers only the gaps not present in those files.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  loadSkillsIndexFromFolders,
  loadSkillBodyFromFolder,
  _fallbackConfig,
} from '../../src/skills/folder-loader.js';
import { loadSkillsIndex, loadSkillContent, saveSkillContent } from '../../src/skills/loader.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

type FolderClientOpts = {
  listResponse?: unknown;
  listError?: { status: number };
  listByPath?: Record<string, unknown>;
  sourceByPath?: Record<string, unknown>;
  configSkills?: {
    key?: string;
    id?: string;
    content?: string;
    value?: string;
    body?: string;
    status?: string;
  }[];
};

function mockFolderClient(opts: FolderClientOpts = {}): DAAdminClient {
  return {
    listSources: async (_org: string, _site: string, path: string) => {
      if (opts.listByPath && path in opts.listByPath) {
        return opts.listByPath[path] as ReturnType<DAAdminClient['listSources']>;
      }
      if (opts.listError) throw opts.listError;
      return opts.listResponse ?? [];
    },
    getSource: async (_org: string, _site: string, path: string) => {
      const val = opts.sourceByPath?.[path];
      if (val === undefined) {
        throw Object.assign(new Error('not found'), { status: 404 });
      }
      return val as ReturnType<DAAdminClient['getSource']>;
    },
    getSiteConfig: async () => {
      if (!opts.configSkills) throw Object.assign(new Error('not found'), { status: 404 });
      return {
        skills: {
          data: opts.configSkills,
          total: opts.configSkills.length,
        },
      };
    },
  } as unknown as DAAdminClient;
}

type SheetClientOpts = {
  config?: Record<string, unknown>;
  getError?: Error;
  saveError?: Error;
  savedConfigs?: Record<string, unknown>[];
};

function mockSheetClient(opts: SheetClientOpts = {}): DAAdminClient {
  return {
    getSiteConfig: async () => {
      if (opts.getError) throw opts.getError;
      if (!opts.config) throw Object.assign(new Error('not found'), { status: 404 });
      return opts.config;
    },
    saveSiteConfig: async (_org: string, _site: string, cfg: Record<string, unknown>) => {
      if (opts.saveError) throw opts.saveError;
      opts.savedConfigs?.push(structuredClone(cfg));
      return { ok: true };
    },
  } as unknown as DAAdminClient;
}

const SKILL_MD = (name: string, description: string, status = 'approved') =>
  `---\nname: ${name}\ndescription: ${description}\nstatus: ${status}\n---\n# ${name}\n\nBody text for ${name}.`;

// ---------------------------------------------------------------------------
// loadSkillsIndexFromFolders — frozen behaviors not covered by folder-loader.test.ts
// ---------------------------------------------------------------------------

describe('[characterization] loadSkillsIndexFromFolders — entry name filtering', () => {
  /**
   * isFolderEntry: only entries where !ext AND /^[a-z0-9-]+$/.test(name)
   * Entries with uppercase letters, underscores, dots, or spaces are excluded.
   * Covered: ext-filter → folder-loader.test.ts "ignores folder entries with an ext"
   * NOT covered: name regex — uppercase, underscore, space, etc.
   */

  it('excludes folder entries whose name contains uppercase letters', async () => {
    const client = mockFolderClient({
      listResponse: [
        { name: 'valid-skill', path: '/.da/skills/valid-skill' },
        { name: 'InvalidSkill', path: '/.da/skills/InvalidSkill' },
      ],
      sourceByPath: {
        '.da/skills/valid-skill/skill.md': SKILL_MD('valid-skill', 'Valid'),
        '.da/skills/InvalidSkill/skill.md': SKILL_MD('InvalidSkill', 'Invalid'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills.map((s) => s.id)).toEqual(['valid-skill']);
  });

  it('excludes folder entries whose name contains underscores', async () => {
    const client = mockFolderClient({
      listResponse: [
        { name: 'my_skill', path: '/.da/skills/my_skill' },
        { name: 'my-skill', path: '/.da/skills/my-skill' },
      ],
      sourceByPath: {
        '.da/skills/my-skill/skill.md': SKILL_MD('my-skill', 'Desc'),
        '.da/skills/my_skill/skill.md': SKILL_MD('my_skill', 'Desc'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills.map((s) => s.id)).toEqual(['my-skill']);
  });

  it('includes entries with digits in their name', async () => {
    const client = mockFolderClient({
      listResponse: [{ name: 'skill-v2', path: '/.da/skills/skill-v2' }],
      sourceByPath: {
        '.da/skills/skill-v2/skill.md': SKILL_MD('skill-v2', 'Version 2'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills[0]?.id).toBe('skill-v2');
  });
});

describe('[characterization] loadSkillsIndexFromFolders — all-unreadable folder stops sheet fallback', () => {
  /**
   * When the folder list returns entries but every skill.md is unreadable (404),
   * mapPool resolves them all to undefined/null → skills=[].
   * Because folderEntries.length > 0 we take the folder branch and return
   * { skills: [], source: 'folder' } WITHOUT falling through to the config sheet.
   *
   * The existing test "returns source=folder with empty skills when all folder skills are draft"
   * covers the draft variant. This covers the 404-per-file variant.
   */

  it('returns {skills:[], source:"folder"} when all skill.md files are missing (404)', async () => {
    const client = mockFolderClient({
      listResponse: [
        { name: 'ghost-a', path: '/.da/skills/ghost-a' },
        { name: 'ghost-b', path: '/.da/skills/ghost-b' },
      ],
      // sourceByPath intentionally omitted → all getSource calls throw 404
      configSkills: [{ key: 'sheet-skill', content: '# Sheet\n\nStale.' }],
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('folder');
    expect(index.skills).toHaveLength(0);
    // Sheet skill must NOT appear
    expect(index.skills.some((s) => s.id === 'sheet-skill')).toBe(false);
  });
});

describe('[characterization] loadSkillsIndexFromFolders — skills have no execution field', () => {
  /**
   * Skills loaded from .da/skills must never carry an `execution` field.
   * The prose-only tests in folder-loader.test.ts cover the case where
   * execution frontmatter IS present. This asserts the normal approved path.
   */

  it('every skill in a folder result has no execution property', async () => {
    const client = mockFolderClient({
      listResponse: [
        { name: 'brand-voice', path: '/.da/skills/brand-voice' },
        { name: 'seo-check', path: '/.da/skills/seo-check' },
      ],
      sourceByPath: {
        '.da/skills/brand-voice/skill.md': SKILL_MD('brand-voice', 'Brand tone'),
        '.da/skills/seo-check/skill.md': SKILL_MD('seo-check', 'SEO checks'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    for (const skill of index.skills) {
      expect(skill.execution).toBeUndefined();
    }
  });
});

describe('[characterization] loadSkillsIndexFromFolders — fallback disabled + folder missing', () => {
  afterEach(() => {
    _fallbackConfig.enabled = true;
  });

  /**
   * Existing test: "returns empty index when folder walk is empty and fallback is disabled"
   * (covers empty list). This covers the 4xx-missing-folder case with fallback off.
   */
  it('returns {skills:[], source:"none"} when folder is missing (4xx) and fallback disabled', async () => {
    _fallbackConfig.enabled = false;
    const client = mockFolderClient({
      listError: { status: 404 },
      configSkills: [{ key: 'sheet-skill', content: '# Sheet\n\nContent.' }],
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('none');
    expect(index.skills).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadSkillBodyFromFolder — frozen behaviors not covered by folder-loader.test.ts
// ---------------------------------------------------------------------------

describe('[characterization] loadSkillBodyFromFolder — non-404 getSource error does NOT fall to sheet', () => {
  /**
   * When getSource throws a non-404 error (e.g. 500), the function returns null
   * immediately and does NOT fall through to the sheet fallback. A server error
   * is a hard failure — silently serving stale sheet content would mask it.
   */
  it('returns null on non-404 getSource error and does not consult sheet fallback', async () => {
    const client = mockFolderClient({
      sourceByPath: {
        // Simulate by overriding via custom client below
      },
      configSkills: [{ key: 'my-skill', content: '# My Skill\n\nContent.' }],
    });
    // Override getSource to throw a 500
    const customClient = {
      ...client,
      getSource: async () => {
        throw Object.assign(new Error('server error'), { status: 500 });
      },
    } as unknown as DAAdminClient;

    const body = await loadSkillBodyFromFolder(customClient, 'org', 'mysite', 'my-skill');
    // Corrected behavior: non-404 errors return null; sheet is NOT consulted
    expect(body).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadSkillsIndex (sheet) — frozen behaviors not covered by loader.test.ts
// ---------------------------------------------------------------------------

describe('[characterization] loadSkillsIndex — title extraction', () => {
  /**
   * extractTitle: first non-empty line; if it starts with #+ it strips the heading marker.
   * loader.test.ts covers heading titles. This covers the plain-first-line case.
   */

  it('uses first non-empty plain line as title when no heading marker present', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'plain', content: 'This is a plain title\n\nBody.' }],
          total: 1,
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills[0]?.title).toBe('This is a plain title');
  });

  it('strips heading markers and returns heading text as title', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'heading', content: '## My Skill Heading\n\nBody.' }],
          total: 1,
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills[0]?.title).toBe('My Skill Heading');
  });

  it('skips blank lines to find the first non-empty line', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'blank-lead', content: '\n\n\n# Real Title\n\nBody.' }],
          total: 1,
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills[0]?.title).toBe('Real Title');
  });
});

describe('[characterization] loadSkillsIndex — source values', () => {
  it('returns source="site" when at least one skill is present', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'a-skill', content: '# A\n\nBody.' }],
          total: 1,
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.source).toBe('site');
  });

  it('returns source="none" when skills sheet exists but all rows are draft', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'wip', content: '# WIP\n\nx', status: 'draft' }],
          total: 1,
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.source).toBe('none');
    expect(index.skills).toHaveLength(0);
  });
});

describe('[characterization] loadSkillsIndex — column name variants', () => {
  /**
   * Row schema accepts: key|id for the skill id, content|value|body for the text.
   * loader.test.ts only uses `key` + `content`. These freeze the other variants.
   */

  it('accepts "id" column as skill identifier', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ id: 'id-skill', content: '# Id Skill\n\nBody.' }],
          total: 1,
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills[0]?.id).toBe('id-skill');
  });

  it('accepts "value" column as skill content', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'val-skill', value: '# Value Skill\n\nBody.' }],
          total: 1,
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills[0]?.id).toBe('val-skill');
    expect(index.skills[0]?.title).toBe('Value Skill');
  });

  it('accepts "body" column as skill content', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'body-skill', body: '# Body Skill\n\nText.' }],
          total: 1,
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills[0]?.id).toBe('body-skill');
    expect(index.skills[0]?.title).toBe('Body Skill');
  });

  it('strips .md suffix from key column', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'brand-voice.md', content: '# Brand\n\nTone.' }],
          total: 1,
        },
      },
    });

    const index = await loadSkillsIndex(client, 'org', 'mysite');
    expect(index.skills[0]?.id).toBe('brand-voice');
  });
});

// ---------------------------------------------------------------------------
// loadSkillContent (sheet) — frozen behaviors not covered by loader.test.ts
// ---------------------------------------------------------------------------

describe('[characterization] loadSkillContent — column variants', () => {
  it('finds skill by "id" column', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ id: 'my-skill', content: '# My\n\nContent.' }],
        },
      },
    });

    const result = await loadSkillContent(client, 'org', 'mysite', 'my-skill');
    expect(result).toBe('# My\n\nContent.');
  });

  it('reads content from "value" column', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'val-skill', value: '# Val\n\nBody.' }],
        },
      },
    });

    const result = await loadSkillContent(client, 'org', 'mysite', 'val-skill');
    expect(result).toBe('# Val\n\nBody.');
  });

  it('reads content from "body" column', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'body-skill', body: '# Body\n\nText.' }],
        },
      },
    });

    const result = await loadSkillContent(client, 'org', 'mysite', 'body-skill');
    expect(result).toBe('# Body\n\nText.');
  });

  it('normalizes .md suffix in lookup id', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'brand-voice', content: '# Brand\n\nTone.' }],
        },
      },
    });

    const result = await loadSkillContent(client, 'org', 'mysite', 'brand-voice.md');
    expect(result).toBe('# Brand\n\nTone.');
  });

  it('returns null when getSiteConfig throws', async () => {
    const client = mockSheetClient({ getError: new Error('network failure') });
    const result = await loadSkillContent(client, 'org', 'mysite', 'any-skill');
    expect(result).toBeNull();
  });

  it('returns trimmed content (strips leading/trailing whitespace)', async () => {
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'padded', content: '   # Padded\n\nBody.   ' }],
        },
      },
    });

    const result = await loadSkillContent(client, 'org', 'mysite', 'padded');
    expect(result).toBe('# Padded\n\nBody.');
  });
});

// ---------------------------------------------------------------------------
// saveSkillContent — frozen behaviors not covered by loader.test.ts
// ---------------------------------------------------------------------------

describe('[characterization] saveSkillContent — sheet creation and updates', () => {
  it('creates skills sheet when absent in config', async () => {
    const savedConfigs: Record<string, unknown>[] = [];
    const client = mockSheetClient({
      config: { 'mcp-servers': { data: [], total: 0 } }, // no skills sheet
      savedConfigs,
    });

    const result = await saveSkillContent(client, 'org', 'mysite', 'new-skill', '# New\n\nContent');
    expect(result.success).toBe(true);
    const saved = savedConfigs[0] as Record<string, unknown>;
    expect(saved).toHaveProperty('skills');
    const sheet = saved.skills as { data: unknown[] };
    expect(sheet.data).toHaveLength(1);
  });

  it('updates existing row rather than appending a duplicate', async () => {
    const savedConfigs: Record<string, unknown>[] = [];
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'my-skill', content: '# Old\n\nOld content.', status: 'approved' }],
          total: 1,
        },
      },
      savedConfigs,
    });

    const result = await saveSkillContent(
      client,
      'org',
      'mysite',
      'my-skill',
      '# New\n\nNew content',
    );
    expect(result.success).toBe(true);
    const saved = savedConfigs[0] as Record<string, unknown>;
    const sheet = saved.skills as { data: { key: string; content: string }[] };
    expect(sheet.data).toHaveLength(1);
    expect(sheet.data[0].content).toBe('# New\n\nNew content');
  });

  it('preserves existing status when no options.status provided', async () => {
    const savedConfigs: Record<string, unknown>[] = [];
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'skill-a', content: '# A', status: 'draft' }],
          total: 1,
        },
      },
      savedConfigs,
    });

    await saveSkillContent(client, 'org', 'mysite', 'skill-a', '# A updated');
    const saved = savedConfigs[0] as Record<string, unknown>;
    const sheet = saved.skills as { data: { status: string }[] };
    // Status was 'draft' on the existing row and no override was given — should stay 'draft'
    expect(sheet.data[0].status).toBe('draft');
  });

  it('sets status to provided options.status on update', async () => {
    const savedConfigs: Record<string, unknown>[] = [];
    const client = mockSheetClient({
      config: {
        skills: {
          data: [{ key: 'skill-b', content: '# B', status: 'draft' }],
          total: 1,
        },
      },
      savedConfigs,
    });

    await saveSkillContent(client, 'org', 'mysite', 'skill-b', '# B approved', {
      status: 'approved',
    });
    const saved = savedConfigs[0] as Record<string, unknown>;
    const sheet = saved.skills as { data: { status: string }[] };
    expect(sheet.data[0].status).toBe('approved');
  });

  it('sets status to "approved" for new skill when no options.status given', async () => {
    // skillRowStatus(undefined) returns 'approved' — new rows default to approved
    const savedConfigs: Record<string, unknown>[] = [];
    const client = mockSheetClient({
      config: { skills: { data: [], total: 0 } },
      savedConfigs,
    });

    await saveSkillContent(client, 'org', 'mysite', 'fresh-skill', '# Fresh');
    const saved = savedConfigs[0] as Record<string, unknown>;
    const sheet = saved.skills as { data: { status: string }[] };
    expect(sheet.data[0].status).toBe('approved');
  });

  it('starts from empty config when getSiteConfig returns 404', async () => {
    const savedConfigs: Record<string, unknown>[] = [];
    // getError with status 404
    const client: DAAdminClient = {
      getSiteConfig: async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      },
      saveSiteConfig: async (_org: string, _site: string, cfg: Record<string, unknown>) => {
        savedConfigs.push(structuredClone(cfg));
        return { ok: true };
      },
    } as unknown as DAAdminClient;

    const result = await saveSkillContent(client, 'org', 'mysite', 'new-skill', '# New');
    expect(result.success).toBe(true);
    const saved = savedConfigs[0] as Record<string, unknown>;
    expect(saved).toHaveProperty('skills');
  });

  it('returns {success:false, error} when skill id is empty', async () => {
    const client = mockSheetClient({ config: {} });
    const result = await saveSkillContent(client, 'org', 'mysite', '', '# Content');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('normalizes .md suffix in skill id before saving', async () => {
    const savedConfigs: Record<string, unknown>[] = [];
    const client = mockSheetClient({
      config: { skills: { data: [], total: 0 } },
      savedConfigs,
    });

    await saveSkillContent(client, 'org', 'mysite', 'my-skill.md', '# My');
    const saved = savedConfigs[0] as Record<string, unknown>;
    const sheet = saved.skills as { data: { key: string }[] };
    expect(sheet.data[0].key).toBe('my-skill');
  });

  it('updates total count when adding a new skill', async () => {
    const savedConfigs: Record<string, unknown>[] = [];
    const client = mockSheetClient({
      config: {
        skills: { data: [{ key: 'existing', content: '# Existing' }], total: 1 },
      },
      savedConfigs,
    });

    await saveSkillContent(client, 'org', 'mysite', 'brand-new', '# Brand New');
    const saved = savedConfigs[0] as Record<string, unknown>;
    const sheet = saved.skills as { data: unknown[]; total: number };
    expect(sheet.data).toHaveLength(2);
    expect(sheet.total).toBe(2);
  });
});
