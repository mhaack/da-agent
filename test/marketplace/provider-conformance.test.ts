/**
 * Provider conformance suite.
 *
 * Runs the SAME set of behavioral assertions against BOTH:
 *   - GitHubMarketplaceProvider (with mocked fetch)
 *   - AOMarketplaceProvider     (stub, no network)
 *
 * Any implementation that passes all suites satisfies the
 * SkillMarketplaceProvider contract, proving swappability.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitHubMarketplaceProvider } from '../../src/marketplace/gh-provider.js';
import { AOMarketplaceProvider } from '../../src/marketplace/ao-provider.js';
import type { SkillMarketplaceProvider } from '../../src/marketplace/provider.js';

// ---------------------------------------------------------------------------
// Shared mock helpers (GitHub provider only)
// ---------------------------------------------------------------------------

const OWNER = 'exp-workspace';
const REPO = 'skills';
const BRANCH = 'main';
const PATH = 'ew';

const CONTENTS_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`;
const rawUrl = (id: string, file: string) =>
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${PATH}/${id}/${file}`;
const scriptsUrl = (id: string) =>
  `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}/${id}/scripts?ref=${BRANCH}`;

const SCRIPT_SKILL_MD = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\nversion: 1\nstatus: approved\nexecution_entry: run\nexecution_runtimes: js\nexecution_capabilities: dom\nexecution_timeout_ms: 5000\n---\n# ${name}\n\nBody.`;

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

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Conformance suite — run once per provider
// ---------------------------------------------------------------------------

/**
 * Defines the shape of a "provider factory" used by the conformance suite.
 * For GitHub we set up a mock-fetch scenario that returns one skill.
 * For AO the stub already has canned data.
 */
interface ProviderScenario {
  /** Human-readable provider name used in describe labels. */
  name: string;
  /**
   * Prepare the provider under test.
   * May install fetch mocks as a side-effect — those are cleaned up by afterEach.
   */
  make(): SkillMarketplaceProvider;
  /**
   * The id of the skill this provider is expected to return from `listSkills`.
   * The conformance suite uses this id for `getSkillManifest` and `getScript`.
   */
  expectedId: string;
}

const scenarios: ProviderScenario[] = [
  {
    name: 'GitHubMarketplaceProvider',
    make() {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          [CONTENTS_URL]: {
            ok: true,
            body: [{ name: 'conformance-skill', type: 'dir', path: 'conformance-skill' }],
          },
          [rawUrl('conformance-skill', 'skill.md')]: {
            ok: true,
            body: SCRIPT_SKILL_MD('conformance-skill', 'Conformance skill'),
          },
          [scriptsUrl('conformance-skill')]: {
            ok: true,
            body: [
              {
                name: 'run.js',
                type: 'file',
                path: 'conformance-skill/scripts/run.js',
              },
            ],
          },
        }),
      );
      return new GitHubMarketplaceProvider({
        owner: OWNER,
        repo: REPO,
        branch: BRANCH,
        path: PATH,
      });
    },
    expectedId: 'conformance-skill',
  },
  {
    name: 'AOMarketplaceProvider',
    make() {
      return new AOMarketplaceProvider();
    },
    expectedId: 'ao-stub-skill',
  },
];

for (const scenario of scenarios) {
  describe(`[conformance] ${scenario.name}`, () => {
    // ------------------------------------------------------------------
    // listSkills
    // ------------------------------------------------------------------

    it('listSkills returns a non-empty array', async () => {
      const provider = scenario.make();
      const skills = await provider.listSkills();
      expect(skills.length).toBeGreaterThan(0);
    });

    it('every skill from listSkills has id, title, execution, and source="marketplace"', async () => {
      const provider = scenario.make();
      const skills = await provider.listSkills();
      for (const skill of skills) {
        expect(typeof skill.id).toBe('string');
        expect(skill.id.length).toBeGreaterThan(0);
        expect(typeof skill.title).toBe('string');
        expect(skill.title.length).toBeGreaterThan(0);
        expect(skill.execution).toBeDefined();
        expect(skill.source).toBe('marketplace');
      }
    });

    it('listSkills includes the expected skill id', async () => {
      const provider = scenario.make();
      const skills = await provider.listSkills();
      expect(skills.some((s) => s.id === scenario.expectedId)).toBe(true);
    });

    it('every execution block has required fields', async () => {
      const provider = scenario.make();
      const skills = await provider.listSkills();
      for (const skill of skills) {
        const exec = skill.execution!;
        expect(typeof exec.entry).toBe('string');
        expect(Array.isArray(exec.runtimes)).toBe(true);
        expect(exec.runtimes.length).toBeGreaterThan(0);
        expect(Array.isArray(exec.capabilities)).toBe(true);
        expect(typeof exec.timeoutMs).toBe('number');
        expect(exec.timeoutMs).toBeGreaterThan(0);
        expect(Array.isArray(exec.dependencies)).toBe(true);
      }
    });

    // ------------------------------------------------------------------
    // getSkillManifest
    // ------------------------------------------------------------------

    it('getSkillManifest returns a manifest for a known skill id', async () => {
      const provider = scenario.make();
      const manifest = await provider.getSkillManifest(scenario.expectedId);
      expect(manifest).not.toBeNull();
      expect(manifest!.id).toBe(scenario.expectedId);
      expect(typeof manifest!.title).toBe('string');
      expect(manifest!.execution).toBeDefined();
    });

    it('getSkillManifest returns null for an unknown id', async () => {
      const provider = scenario.make();
      const manifest = await provider.getSkillManifest('__does-not-exist__');
      expect(manifest).toBeNull();
    });

    // ------------------------------------------------------------------
    // getScript
    // ------------------------------------------------------------------

    it('getScript returns source or url for a known skill + supported runtime', async () => {
      const provider = scenario.make();
      const result = await provider.getScript(scenario.expectedId, 'js');
      expect(result).not.toBeNull();
      // Must be one of the two valid shapes.
      const hasSource = result !== null && 'source' in result;
      const hasUrl = result !== null && 'url' in result;
      expect(hasSource || hasUrl).toBe(true);
    });

    it('getScript returns null for an unknown skill id', async () => {
      const provider = scenario.make();
      const result = await provider.getScript('__does-not-exist__', 'js');
      expect(result).toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// Resilience: listSkills never throws (GitHub provider, network error)
// ---------------------------------------------------------------------------

describe('GitHubMarketplaceProvider resilience', () => {
  it('listSkills returns [] when fetch throws (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network failure');
      }),
    );
    const provider = new GitHubMarketplaceProvider({
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
      path: PATH,
    });
    const skills = await provider.listSkills();
    expect(skills).toEqual([]);
  });

  it('listSkills returns [] when GH API returns non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [CONTENTS_URL]: { ok: false, status: 503, body: {} },
      }),
    );
    const provider = new GitHubMarketplaceProvider({
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
      path: PATH,
    });
    const skills = await provider.listSkills();
    expect(skills).toEqual([]);
  });
});
