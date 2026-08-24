import { describe, it, expect, afterEach } from 'vitest';
import {
  loadSkillsIndexFromFolders,
  loadSkillBodyFromFolder,
  LEGACY_SKILLS_SHEET_FALLBACK_ENABLED,
  _fallbackConfig,
} from '../../src/skills/folder-loader.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';
import { BUILTIN_SKILLS } from '../../src/skills/builtin-skills.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SKILL_MD = (name: string, description: string, version = 1, status = 'approved') =>
  `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\nstatus: ${status}\n---\n# ${name}\n\nBody text for ${name}.`;

const SCRIPT_SKILL_MD = (name: string, description: string, version = 1, status = 'approved') =>
  `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\nstatus: ${status}\nexecution_entry: convert\nexecution_runtimes: js\nexecution_capabilities: \nexecution_timeout_ms: 5000\n---\n# ${name}\n\nBody text for ${name}.`;

const BODY_ONLY = (name: string) => `# ${name}\n\nBody text for ${name}.`;

type ClientOpts = {
  listResponse?: unknown;
  listError?: { status: number };
  /** path → raw list response (array) OR source content (string/object) */
  listByPath?: Record<string, unknown>;
  /** path → raw response (string for .md, object for JSON) */
  sourceByPath?: Record<string, unknown>;
  /** config sheet skills data for legacy fallback */
  configSkills?: { key: string; content: string; status?: string }[];
};

function mockClient(opts: ClientOpts = {}): DAAdminClient {
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
        const err = Object.assign(new Error('not found'), { status: 404 });
        throw err;
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

// ---------------------------------------------------------------------------
// loadSkillsIndexFromFolders
// ---------------------------------------------------------------------------

describe('loadSkillsIndexFromFolders', () => {
  it('builds index from folder-layout skills', async () => {
    const client = mockClient({
      listResponse: [
        { name: 'brand-voice', path: '/.da/skills/brand-voice' },
        { name: 'seo-checklist', path: '/.da/skills/seo-checklist' },
      ],
      sourceByPath: {
        '.da/skills/brand-voice/skill.md': SKILL_MD('brand-voice', 'Enforce brand tone guidelines'),
        '.da/skills/seo-checklist/skill.md': SKILL_MD(
          'seo-checklist',
          'Run SEO checks before publish',
        ),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('folder');
    expect(index.skills).toHaveLength(2);
    expect(index.skills[0]).toEqual({ id: 'brand-voice', title: 'Enforce brand tone guidelines' });
    expect(index.skills[1]).toEqual({
      id: 'seo-checklist',
      title: 'Run SEO checks before publish',
    });
  });

  it('excludes draft skills from the index', async () => {
    const client = mockClient({
      listResponse: [
        { name: 'live-skill', path: '/.da/skills/live-skill' },
        { name: 'wip-skill', path: '/.da/skills/wip-skill' },
      ],
      sourceByPath: {
        '.da/skills/live-skill/skill.md': SKILL_MD('live-skill', 'Live description', 1, 'approved'),
        '.da/skills/wip-skill/skill.md': SKILL_MD('wip-skill', 'WIP description', 1, 'draft'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]?.id).toBe('live-skill');
  });

  it('skips folder entries without a readable skill.md', async () => {
    const client = mockClient({
      listResponse: [
        { name: 'good-skill', path: '/.da/skills/good-skill' },
        { name: 'broken-skill', path: '/.da/skills/broken-skill' },
      ],
      sourceByPath: {
        '.da/skills/good-skill/skill.md': SKILL_MD('good-skill', 'Good skill', 1),
        // broken-skill/skill.md is missing → throws 404
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]?.id).toBe('good-skill');
  });

  it('ignores folder entries with an ext (they are files, not folders)', async () => {
    const client = mockClient({
      listResponse: [
        { name: 'valid-skill', path: '/.da/skills/valid-skill' },
        { name: 'some-file', ext: '.json', path: '/.da/skills/some-file.json' },
      ],
      sourceByPath: {
        '.da/skills/valid-skill/skill.md': SKILL_MD('valid-skill', 'A skill', 1),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(1);
  });

  it('falls back to config sheet when list returns empty and legacy is enabled', async () => {
    expect(LEGACY_SKILLS_SHEET_FALLBACK_ENABLED).toBe(true);

    const client = mockClient({
      listResponse: [],
      configSkills: [{ key: 'legacy-skill', content: '# Legacy\n\nOld way.' }],
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('site');
    expect(index.skills.some((s) => s.id === 'legacy-skill')).toBe(true);
  });

  it('falls back to config sheet on 4xx (folder not found) without counting as legacy hit', async () => {
    // 4xx is a normal new-site state. sheet fallback still runs so existing
    // sheet skills stay visible, but getSiteConfig must be called exactly once.
    let configCalls = 0;
    const base = mockClient({
      listError: { status: 404 },
      configSkills: [{ key: 'sheet-skill', content: '# Sheet\n\nContent.' }],
    });
    const client = {
      ...base,
      getSiteConfig: async (...args: Parameters<typeof base.getSiteConfig>) => {
        configCalls += 1;
        return base.getSiteConfig(...args);
      },
    } as typeof base;

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('site');
    expect(configCalls).toBe(1);
  });

  it('falls back to config sheet on 5xx list error', async () => {
    const client = mockClient({
      listError: { status: 503 },
      configSkills: [{ key: 'sheet-skill', content: '# Sheet\n\nContent.' }],
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('site');
  });

  it('returns empty index when fallback config sheet is also empty', async () => {
    const client = mockClient({
      listResponse: [],
      configSkills: [],
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(0);
    expect(index.source).toBe('none');
  });

  it('returns source=folder when skills are found via folder walk', async () => {
    const client = mockClient({
      listResponse: [{ name: 'a-skill', path: '/.da/skills/a-skill' }],
      sourceByPath: {
        '.da/skills/a-skill/skill.md': SKILL_MD('a-skill', 'Desc', 1),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('folder');
  });

  it('returns source=folder with empty skills when all folder skills are draft', async () => {
    // All skills are draft: the folder was found, so we must NOT fall back to
    // the sheet. Draft status is intentional; using sheet data would resurrect
    // stale content.
    const client = mockClient({
      listResponse: [
        { name: 'wip-one', path: '/.da/skills/wip-one' },
        { name: 'wip-two', path: '/.da/skills/wip-two' },
      ],
      sourceByPath: {
        '.da/skills/wip-one/skill.md': SKILL_MD('wip-one', 'Draft one', 1, 'draft'),
        '.da/skills/wip-two/skill.md': SKILL_MD('wip-two', 'Draft two', 1, 'draft'),
      },
      configSkills: [{ key: 'old-skill', content: '# Old\n\nStale content.' }],
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('folder');
    expect(index.skills).toHaveLength(0);
    // sheet skill must NOT appear — folder took precedence
    expect(index.skills.some((s) => s.id === 'old-skill')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LEGACY_SKILLS_SHEET_FALLBACK_ENABLED = false
// ---------------------------------------------------------------------------

describe('loadSkillsIndexFromFolders (legacy fallback disabled)', () => {
  afterEach(() => {
    _fallbackConfig.enabled = true;
  });

  it('returns empty index when folder walk is empty and fallback is disabled', async () => {
    _fallbackConfig.enabled = false;

    const client = mockClient({
      listResponse: [],
      configSkills: [{ key: 'sheet-skill', content: '# Sheet\n\nContent.' }],
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills).toHaveLength(0);
    expect(index.source).toBe('none');
  });

  it('never calls getSiteConfig when fallback is disabled', async () => {
    _fallbackConfig.enabled = false;

    let configCalls = 0;
    const base = mockClient({ listResponse: [] });
    const client = {
      ...base,
      getSiteConfig: async () => {
        configCalls += 1;
        return {};
      },
    } as typeof base;

    await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(configCalls).toBe(0);
  });

  it('still returns folder skills when they exist, regardless of flag', async () => {
    _fallbackConfig.enabled = false;

    const client = mockClient({
      listResponse: [{ name: 'live-skill', path: '/.da/skills/live-skill' }],
      sourceByPath: {
        '.da/skills/live-skill/skill.md': SKILL_MD('live-skill', 'Live desc', 1),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('folder');
    expect(index.skills).toHaveLength(1);
  });
});

describe('loadSkillBodyFromFolder (legacy fallback disabled)', () => {
  afterEach(() => {
    _fallbackConfig.enabled = true;
  });

  it('returns null when skill.md not found and fallback is disabled', async () => {
    _fallbackConfig.enabled = false;

    const client = mockClient({
      configSkills: [{ key: 'sheet-skill', content: '# Sheet\n\nContent.' }],
    });

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'sheet-skill');
    expect(body).toBeNull();
  });

  it('never calls getSiteConfig when fallback is disabled', async () => {
    _fallbackConfig.enabled = false;

    let configCalls = 0;
    const base = mockClient({});
    const client = {
      ...base,
      getSiteConfig: async () => {
        configCalls += 1;
        return {};
      },
    } as typeof base;

    await loadSkillBodyFromFolder(client, 'org', 'mysite', 'any-skill');
    expect(configCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadSkillBodyFromFolder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prose-only enforcement (.da/skills must never carry execution metadata)
// ---------------------------------------------------------------------------

describe('loadSkillsIndexFromFolders — prose-only enforcement', () => {
  it('ignores script.js and never populates execution, even when execution frontmatter and script.js are both present', async () => {
    // Security: .da/skills is user-writable site content. A script.js there
    // must be ignored so no user can ship code that runs in other browsers.
    // Script-carrying skills come exclusively from the curated GH marketplace.
    const client = mockClient({
      listByPath: {
        '.da/skills': [{ name: 'convert-tables', path: '/.da/skills/convert-tables' }],
        '.da/skills/convert-tables': [
          { name: 'skill', ext: '.md', path: '/.da/skills/convert-tables/skill.md' },
          { name: 'script', ext: '.js', path: '/.da/skills/convert-tables/script.js' },
        ],
      },
      sourceByPath: {
        '.da/skills/convert-tables/skill.md': SCRIPT_SKILL_MD(
          'convert-tables',
          'Convert HTML tables to Markdown',
        ),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.source).toBe('folder');
    expect(index.skills).toHaveLength(1);
    const skill = index.skills[0]!;
    expect(skill.id).toBe('convert-tables');
    // execution must be absent regardless of frontmatter or script.js sibling
    expect(skill.execution).toBeUndefined();
  });

  it('leaves execution undefined when execution frontmatter present but no script.js', async () => {
    const client = mockClient({
      listByPath: {
        '.da/skills': [{ name: 'convert-tables', path: '/.da/skills/convert-tables' }],
        '.da/skills/convert-tables': [
          { name: 'skill', ext: '.md', path: '/.da/skills/convert-tables/skill.md' },
        ],
      },
      sourceByPath: {
        '.da/skills/convert-tables/skill.md': SCRIPT_SKILL_MD(
          'convert-tables',
          'Convert HTML tables',
        ),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills[0]?.execution).toBeUndefined();
  });

  it('leaves execution undefined for prose-only skills (no execution frontmatter)', async () => {
    const client = mockClient({
      listByPath: {
        '.da/skills': [{ name: 'brand-voice', path: '/.da/skills/brand-voice' }],
      },
      sourceByPath: {
        '.da/skills/brand-voice/skill.md': SKILL_MD('brand-voice', 'Enforce brand tone'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    expect(index.skills[0]?.execution).toBeUndefined();
  });
});

describe('loadSkillBodyFromFolder', () => {
  it('reads folder skill and strips frontmatter', async () => {
    const client = mockClient({
      sourceByPath: {
        '.da/skills/brand-voice/skill.md': SKILL_MD('brand-voice', 'Enforce tone', 1),
      },
    });

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'brand-voice');
    expect(body).toBeTruthy();
    expect(body).toContain('Body text for brand-voice');
    expect(body).not.toContain('---');
    expect(body).not.toContain('name: brand-voice');
  });

  it('falls back to config sheet when skill.md not found', async () => {
    const client = mockClient({
      // no sourceByPath → getSource throws 404
      configSkills: [{ key: 'legacy-skill', content: '# Legacy\n\nLegacy body.' }],
    });

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'legacy-skill');
    expect(body).toContain('Legacy body.');
  });

  it('returns null when not found in either location', async () => {
    const client = mockClient({
      configSkills: [],
    });

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'nonexistent');
    expect(body).toBeNull();
  });

  it('returns null for empty skill id', async () => {
    const body = await loadSkillBodyFromFolder(mockClient(), 'org', 'mysite', '');
    expect(body).toBeNull();
  });

  it('strips .md extension from skill id before building path', async () => {
    const client = mockClient({
      sourceByPath: {
        '.da/skills/brand-voice/skill.md': SKILL_MD('brand-voice', 'Enforce tone', 1),
      },
    });

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'brand-voice.md');
    expect(body).toContain('Body text for brand-voice');
  });

  it('returns body-only content when skill has no frontmatter', async () => {
    const client = mockClient({
      sourceByPath: {
        '.da/skills/no-fm/skill.md': BODY_ONLY('no-fm'),
      },
    });

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'no-fm');
    expect(body).toContain('Body text for no-fm');
  });

  it('returns null on non-404 getSource error and does not consult the sheet', async () => {
    // A transient 5xx/network error must not cause stale sheet content to be served.
    let configCalls = 0;
    const base = mockClient({
      configSkills: [{ key: 'my-skill', content: '# Stale\n\nOld content.' }],
    });
    // Override getSource to throw a 503 instead of a 404
    const client = {
      ...base,
      getSource: async (_org: string, _site: string, _path: string) => {
        throw Object.assign(new Error('service unavailable'), { status: 503 });
      },
      getSiteConfig: async (...args: Parameters<typeof base.getSiteConfig>) => {
        configCalls += 1;
        return base.getSiteConfig(...args);
      },
    } as typeof base;

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'my-skill');
    expect(body).toBeNull();
    expect(configCalls).toBe(0);
  });

  it('falls back to sheet on explicit 404 (file genuinely absent)', async () => {
    // A 404 means the folder skill does not exist; sheet fallback is correct.
    const client = mockClient({
      // no sourceByPath → getSource throws 404
      configSkills: [{ key: 'sheet-only', content: '# Sheet\n\nSheet body.' }],
    });

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'sheet-only');
    expect(body).toContain('Sheet body.');
  });
});

// ---------------------------------------------------------------------------
// Built-in code skills (available to presets, hidden from the index/UI)
// ---------------------------------------------------------------------------

describe('loadSkillBodyFromFolder (built-in code skills)', () => {
  afterEach(() => {
    delete BUILTIN_SKILLS['builtin-only'];
    delete BUILTIN_SKILLS['brand-voice'];
    _fallbackConfig.enabled = true;
  });

  it('resolves a built-in skill when the folder has no skill.md', async () => {
    BUILTIN_SKILLS['builtin-only'] = { body: 'Built-in instructions.' };
    const client = mockClient({ configSkills: [] }); // folder 404, empty sheet

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'builtin-only');
    expect(body).toBe('Built-in instructions.');
  });

  it('lets folder-authored content override a built-in of the same id', async () => {
    BUILTIN_SKILLS['brand-voice'] = { body: 'Built-in body (should be overridden).' };
    const client = mockClient({
      sourceByPath: {
        '.da/skills/brand-voice/skill.md': SKILL_MD('brand-voice', 'Enforce tone', 1),
      },
    });

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'brand-voice');
    expect(body).toContain('Body text for brand-voice');
    expect(body).not.toContain('should be overridden');
  });

  it('prefers a built-in over the legacy config sheet', async () => {
    BUILTIN_SKILLS['builtin-only'] = { body: 'Built-in wins.' };
    const client = mockClient({
      // folder 404, but a sheet row with the same id also exists
      configSkills: [{ key: 'builtin-only', content: '# Legacy\n\nLegacy body.' }],
    });

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'builtin-only');
    expect(body).toBe('Built-in wins.');
  });

  it('resolves a built-in even when the legacy fallback is disabled', async () => {
    _fallbackConfig.enabled = false;
    BUILTIN_SKILLS['builtin-only'] = { body: 'Still available.' };
    const client = mockClient(); // folder 404

    const body = await loadSkillBodyFromFolder(client, 'org', 'mysite', 'builtin-only');
    expect(body).toBe('Still available.');
  });

  it('never lists built-in skills in the folder index (kept out of the UI)', async () => {
    BUILTIN_SKILLS['builtin-only'] = { title: 'Hidden', body: 'Hidden body.' };
    const client = mockClient({
      listResponse: [{ name: 'brand-voice', path: '/.da/skills/brand-voice' }],
      sourceByPath: {
        '.da/skills/brand-voice/skill.md': SKILL_MD('brand-voice', 'Enforce tone'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'mysite');
    const ids = index.skills.map((s) => s.id);
    expect(ids).toContain('brand-voice');
    expect(ids).not.toContain('builtin-only');
  });
});
