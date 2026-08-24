/**
 * Tests for the GH marketplace skill adapter.
 *
 * The adapter fetches skill folders from api.github.com and raw skill.md
 * files from raw.githubusercontent.com.  All network calls are intercepted
 * via vi.stubGlobal('fetch', ...) so tests run offline.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildMarketplaceSkillsIndex,
  mergeMarketplaceSkillsIntoIndex,
} from '../../src/marketplace/gh-skills.js';
import type { SkillsIndex } from '../../src/skills/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCRIPT_SKILL_MD = (name: string, description: string, deps?: string) =>
  `---\nname: ${name}\ndescription: ${description}\nversion: 1\nstatus: approved\nexecution_entry: convert\nexecution_runtimes: js\nexecution_capabilities: dom\nexecution_timeout_ms: 3000${deps !== undefined ? `\nexecution_dependencies: ${deps}` : ''}\n---\n# ${name}\n\nBody text for ${name}.`;

const PROSE_SKILL_MD = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\nversion: 1\nstatus: approved\n---\n# ${name}\n\nBody text for ${name}.`;

type FetchMap = Record<string, { ok: boolean; status?: number; body: unknown }>;

function mockFetch(map: FetchMap) {
  return vi.fn(async (url: string) => {
    const entry = map[url];
    if (!entry) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    return {
      ok: entry.ok,
      status: entry.status ?? (entry.ok ? 200 : 500),
      json: async () => entry.body,
      text: async () => (typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body)),
    };
  });
}

// ---------------------------------------------------------------------------
// Constants (mirror the adapter's hardcoded values for URL construction)
// ---------------------------------------------------------------------------

const OWNER = 'exp-workspace';
const REPO = 'skills';
const BRANCH = 'main';
const NS = 'ew';
const CONTENTS_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${NS}?ref=${BRANCH}`;
const rawUrl = (id: string, file: string) =>
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${NS}/${id}/${file}`;
/** URL used by the adapter to list a skill's `scripts/` sub-folder. */
const scriptsUrl = (id: string) =>
  `https://api.github.com/repos/${OWNER}/${REPO}/contents/${NS}/${id}/scripts?ref=${BRANCH}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildMarketplaceSkillsIndex', () => {
  it('returns a SkillSummary with execution for a skill that has execution_entry + scripts/<entry>.js', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [CONTENTS_URL]: {
          ok: true,
          body: [{ name: 'convert-tables', type: 'dir', path: 'convert-tables' }],
        },
        [rawUrl('convert-tables', 'skill.md')]: {
          ok: true,
          body: SCRIPT_SKILL_MD('convert-tables', 'Convert HTML tables to Markdown'),
        },
        [scriptsUrl('convert-tables')]: {
          ok: true,
          body: [{ name: 'convert.js', type: 'file', path: 'convert-tables/scripts/convert.js' }],
        },
      }),
    );

    const skills = await buildMarketplaceSkillsIndex();
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.id).toBe('convert-tables');
    expect(skill.title).toBe('Convert HTML tables to Markdown');
    expect(skill.source).toBe('marketplace');
    expect(skill.execution).toEqual({
      entry: 'convert',
      runtimes: ['js'],
      capabilities: ['dom'],
      timeoutMs: 3000,
      dependencies: [],
    });
  });

  it('surfaces execution_dependencies in the execution metadata', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [CONTENTS_URL]: {
          ok: true,
          body: [{ name: 'compress-skill', type: 'dir', path: 'compress-skill' }],
        },
        [rawUrl('compress-skill', 'skill.md')]: {
          ok: true,
          body: SCRIPT_SKILL_MD('compress-skill', 'Compress content', 'fflate'),
        },
        [scriptsUrl('compress-skill')]: {
          ok: true,
          body: [{ name: 'convert.js', type: 'file', path: 'compress-skill/scripts/convert.js' }],
        },
      }),
    );

    const skills = await buildMarketplaceSkillsIndex();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.execution?.dependencies).toEqual(['fflate']);
  });

  it('excludes a folder that has execution frontmatter but no scripts/<entry>.js', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [CONTENTS_URL]: {
          ok: true,
          body: [{ name: 'no-script', type: 'dir', path: 'no-script' }],
        },
        [rawUrl('no-script', 'skill.md')]: {
          ok: true,
          body: SCRIPT_SKILL_MD('no-script', 'Missing script'),
        },
        [scriptsUrl('no-script')]: {
          ok: true,
          body: [
            // scripts/ folder exists but the expected convert.js is absent
            { name: 'other.js', type: 'file', path: 'no-script/scripts/other.js' },
          ],
        },
      }),
    );

    const skills = await buildMarketplaceSkillsIndex();
    expect(skills).toHaveLength(0);
  });

  it('excludes a folder when the scripts/ sub-folder does not exist (404)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [CONTENTS_URL]: {
          ok: true,
          body: [{ name: 'no-scripts-folder', type: 'dir', path: 'no-scripts-folder' }],
        },
        [rawUrl('no-scripts-folder', 'skill.md')]: {
          ok: true,
          body: SCRIPT_SKILL_MD('no-scripts-folder', 'Missing scripts folder'),
        },
        // scriptsUrl is not in the map → mockFetch returns 404
      }),
    );

    const skills = await buildMarketplaceSkillsIndex();
    expect(skills).toHaveLength(0);
  });

  it('excludes a folder without execution_entry (prose-only skill)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [CONTENTS_URL]: {
          ok: true,
          body: [{ name: 'brand-voice', type: 'dir', path: 'brand-voice' }],
        },
        [rawUrl('brand-voice', 'skill.md')]: {
          ok: true,
          body: PROSE_SKILL_MD('brand-voice', 'Enforce brand voice'),
        },
      }),
    );

    const skills = await buildMarketplaceSkillsIndex();
    expect(skills).toHaveLength(0);
  });

  it('returns empty array when the marketplace is unreachable (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );

    const skills = await buildMarketplaceSkillsIndex();
    expect(skills).toEqual([]);
  });

  it('returns empty array when the GH API returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [CONTENTS_URL]: { ok: false, status: 503, body: {} },
      }),
    );

    const skills = await buildMarketplaceSkillsIndex();
    expect(skills).toEqual([]);
  });

  it('skips folders whose name does not match [a-z0-9-]+', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [CONTENTS_URL]: {
          ok: true,
          body: [
            { name: 'Convert_Tables', type: 'dir', path: 'Convert_Tables' },
            { name: '.hidden', type: 'dir', path: '.hidden' },
            { name: 'valid-skill', type: 'dir', path: 'valid-skill' },
          ],
        },
        [rawUrl('valid-skill', 'skill.md')]: {
          ok: true,
          body: SCRIPT_SKILL_MD('valid-skill', 'A valid skill'),
        },
        [scriptsUrl('valid-skill')]: {
          ok: true,
          body: [{ name: 'convert.js', type: 'file', path: 'valid-skill/scripts/convert.js' }],
        },
      }),
    );

    const skills = await buildMarketplaceSkillsIndex();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.id).toBe('valid-skill');
  });
});

describe('mergeMarketplaceSkillsIntoIndex', () => {
  it('appends marketplace skills after local prose skills', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [CONTENTS_URL]: {
          ok: true,
          body: [{ name: 'convert-tables', type: 'dir', path: 'convert-tables' }],
        },
        [rawUrl('convert-tables', 'skill.md')]: {
          ok: true,
          body: SCRIPT_SKILL_MD('convert-tables', 'Convert tables'),
        },
        [scriptsUrl('convert-tables')]: {
          ok: true,
          body: [{ name: 'convert.js', type: 'file', path: 'convert-tables/scripts/convert.js' }],
        },
      }),
    );

    const localIndex: SkillsIndex = {
      skills: [{ id: 'brand-voice', title: 'Brand Voice' }],
      source: 'folder',
    };

    const merged = await mergeMarketplaceSkillsIntoIndex(localIndex);
    expect(merged.skills).toHaveLength(2);
    expect(merged.skills[0]!.id).toBe('brand-voice');
    expect(merged.skills[1]!.id).toBe('convert-tables');
    expect(merged.skills[1]!.source).toBe('marketplace');
    // local skills are unchanged
    expect(merged.skills[0]!.source).toBeUndefined();
  });

  it('returns original index unchanged when marketplace fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    const localIndex: SkillsIndex = {
      skills: [{ id: 'brand-voice', title: 'Brand Voice' }],
      source: 'folder',
    };

    const merged = await mergeMarketplaceSkillsIntoIndex(localIndex);
    expect(merged).toBe(localIndex); // same reference — unchanged
  });
});
