/**
 * GitHub-backed marketplace provider.
 *
 * Wraps the existing GitHub contents API + raw HTTPS fetch logic behind the
 * `SkillMarketplaceProvider` interface.  Constructor accepts a config object
 * so the provider can be pointed at any GitHub repo/path without code changes.
 *
 * Security note: script-carrying skills come ONLY from this curated, reviewed
 * marketplace source.  `.da/skills/` is user-writable site content and must
 * never supply executable scripts.
 */

import { parseSkillIndexEntry } from '../skills/frontmatter.js';
import type { SkillSummary } from '../skills/loader.js';
import type { SkillManifest, SkillMarketplaceProvider } from './provider.js';

// ---------------------------------------------------------------------------
// Configuration shape
// ---------------------------------------------------------------------------

export interface GitHubMarketplaceConfig {
  owner: string;
  repo: string;
  branch: string;
  /** Sub-path within the repo that contains skill folders (e.g. `"ew"`). */
  path: string;
}

// ---------------------------------------------------------------------------
// Internal helpers (module-private)
// ---------------------------------------------------------------------------

/** Shape of one entry from the GH contents API response. */
interface GHContentsEntry {
  name: string;
  type: string; // "dir" | "file" | ...
  path: string;
}

/** Skill folder names must match `[a-z0-9-]+` (same rule as .da/skills). */
const SKILL_FOLDER_RE = /^[a-z0-9-]+$/;

async function fetchJson<T>(url: string): Promise<{ data: T } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub's API rejects requests without a User-Agent (403).
        'User-Agent': 'da-agent-skill-marketplace',
      },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: (await res.json()) as T };
  } catch (err) {
    return { error: String(err) };
  }
}

async function fetchText(url: string): Promise<{ text: string } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'da-agent-skill-marketplace' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { text: await res.text() };
  } catch (err) {
    return { error: String(err) };
  }
}

/** Map a runtime identifier to its file extension. */
function runtimeToExt(runtime: string): string {
  return `.${runtime}`;
}

// ---------------------------------------------------------------------------
// GitHubMarketplaceProvider
// ---------------------------------------------------------------------------

export class GitHubMarketplaceProvider implements SkillMarketplaceProvider {
  private readonly cfg: GitHubMarketplaceConfig;

  constructor(cfg: GitHubMarketplaceConfig) {
    this.cfg = cfg;
  }

  // ---- URL builders --------------------------------------------------------

  private contentsUrl(): string {
    const { owner, repo, path, branch } = this.cfg;
    return `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  }

  private rawBaseUrl(): string {
    const { owner, repo, branch, path } = this.cfg;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  }

  private scriptsUrl(id: string): string {
    const { owner, repo, path, branch } = this.cfg;
    return `https://api.github.com/repos/${owner}/${repo}/contents/${path}/${id}/scripts?ref=${branch}`;
  }

  // ---- Internal helpers ----------------------------------------------------

  /**
   * Check whether `<id>/scripts/<entry>.<ext>` exists in the skill's scripts/
   * sub-folder.  Returns false on network errors or when the folder is absent.
   */
  private async hasScript(id: string, entry: string, runtimes: string[]): Promise<boolean> {
    if (!entry || runtimes.length === 0) return false;
    const ext = runtimeToExt(runtimes[0]);
    const expectedFile = `${entry}${ext}`;
    const result = await fetchJson<GHContentsEntry[]>(this.scriptsUrl(id));
    if ('error' in result) return false;
    return result.data.some((e) => e.name === expectedFile && e.type === 'file');
  }

  // ---- SkillMarketplaceProvider interface ----------------------------------

  /**
   * List all script-carrying skills available in this GitHub marketplace.
   *
   * 1. Lists top-level directories via the GH contents API.
   * 2. For each matching directory:
   *    a. Fetches `<id>/skill.md` and parses execution frontmatter.
   *    b. Verifies `<id>/scripts/<entry>.<ext>` exists.
   * 3. Returns only skills that have `execution_entry` AND the scripts file.
   *
   * Returns [] on any network / parse failure.
   */
  async listSkills(): Promise<SkillSummary[]> {
    const rootResult = await fetchJson<GHContentsEntry[]>(this.contentsUrl());
    if ('error' in rootResult) {
      console.warn('[da-agent:marketplace]', 'GH contents fetch failed:', rootResult.error);
      return [];
    }

    const dirs = rootResult.data.filter(
      (entry) => entry.type === 'dir' && SKILL_FOLDER_RE.test(entry.name),
    );

    const results = await Promise.all(
      dirs.map(async (dir): Promise<SkillSummary | null> => {
        const id = dir.name;
        const skillMdUrl = `${this.rawBaseUrl()}/${id}/skill.md`;
        const mdResult = await fetchText(skillMdUrl);
        if ('error' in mdResult) return null;

        const indexed = parseSkillIndexEntry(mdResult.text);
        if (indexed.status === 'draft') return null;
        if (!indexed.execution) return null; // prose-only, skip

        const hasScript = await this.hasScript(
          id,
          indexed.execution.entry,
          indexed.execution.runtimes,
        );
        if (!hasScript) return null;

        const title = indexed.description || indexed.name || id;
        return {
          id,
          title,
          execution: indexed.execution,
          source: 'marketplace',
        } satisfies SkillSummary;
      }),
    );

    return results.filter((s): s is SkillSummary => s !== null);
  }

  /**
   * Fetch and return the full manifest for a single skill.
   * Returns null if the skill is not found, has no execution metadata, or on
   * any network/parse error.
   */
  async getSkillManifest(id: string): Promise<SkillManifest | null> {
    const skillMdUrl = `${this.rawBaseUrl()}/${id}/skill.md`;
    const mdResult = await fetchText(skillMdUrl);
    if ('error' in mdResult) return null;

    const indexed = parseSkillIndexEntry(mdResult.text);
    if (indexed.status === 'draft') return null;
    if (!indexed.execution) return null;

    return {
      id,
      title: indexed.description || indexed.name || id,
      execution: indexed.execution,
    };
  }

  /**
   * Return a URL pointing directly at the raw script file for the given
   * skill+runtime.  Returns null when the script does not exist or on error.
   */
  async getScript(
    id: string,
    runtime: string,
  ): Promise<{ source: string } | { url: string } | null> {
    const manifest = await this.getSkillManifest(id);
    if (!manifest) return null;

    const ext = runtimeToExt(runtime);
    const scriptUrl = `${this.rawBaseUrl()}/${id}/scripts/${manifest.execution.entry}${ext}`;

    // Verify it actually exists before handing out the URL.
    const result = await fetchJson<GHContentsEntry[]>(this.scriptsUrl(id));
    if ('error' in result) return null;
    const filename = `${manifest.execution.entry}${ext}`;
    const exists = result.data.some((e) => e.name === filename && e.type === 'file');
    if (!exists) return null;

    return { url: scriptUrl };
  }
}
