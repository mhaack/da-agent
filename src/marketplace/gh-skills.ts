/**
 * GitHub Marketplace adapter for script-carrying skills.
 *
 * Script-carrying skills come ONLY from this curated, reviewed marketplace.
 * `.da/skills/` is user-writable site content and must never supply executable
 * scripts — that would allow any user to ship code that runs in other users'
 * browsers.  Only skills from this trusted source carry `execution` metadata.
 *
 * This module is the single source of truth for which marketplaces are active
 * (`MARKETPLACES`) and how to obtain a provider for each entry (`providerFor`).
 * The config will later be driven from the config sheet / Skills UI; until then
 * it lives here as an in-code constant.
 *
 * Network calls are resilient: if a marketplace is unreachable the adapter
 * yields an empty list so the chat continues normally.
 */

// DEMO ONLY — prod target is adobe/skills (pending PR approval).
import type { SkillSummary, SkillsIndex } from '../skills/loader.js';
import { GitHubMarketplaceProvider } from './gh-provider.js';
import type { GitHubMarketplaceConfig } from './gh-provider.js';
import type { SkillMarketplaceProvider } from './provider.js';

// ---------------------------------------------------------------------------
// Marketplace registry
// ---------------------------------------------------------------------------

type MarketplaceEntry = { type: 'github' } & GitHubMarketplaceConfig;

/**
 * Ordered list of active marketplaces.
 *
 * DEMO: points at exp-workspace/skills.  Prod target is adobe/skills once PR
 * lands.  This is the single place to add / remove marketplace sources; the
 * resolver iterates this list at runtime.
 */
export const MARKETPLACES: MarketplaceEntry[] = [
  {
    type: 'github',
    owner: 'exp-workspace',
    repo: 'skills',
    branch: 'main',
    path: 'ew',
  },
];

/**
 * Return a `SkillMarketplaceProvider` for the given registry entry.
 *
 * Currently only `'github'` is supported.  Unknown types are logged and
 * silently skipped by the caller — this is the seam where new provider types
 * (AO, local, etc.) will be added in future.
 */
export function providerFor(entry: MarketplaceEntry): SkillMarketplaceProvider {
  if (entry.type === 'github') {
    return new GitHubMarketplaceProvider({
      owner: entry.owner,
      repo: entry.repo,
      branch: entry.branch,
      path: entry.path,
    });
  }
  // Exhaustive check — TypeScript will catch unhandled variants at compile time
  // once additional types are added to MarketplaceEntry.
  const _never: never = entry;
  throw new Error(`[da-agent:marketplace] unknown provider type: ${JSON.stringify(_never)}`);
}

// ---------------------------------------------------------------------------
// Public API — stable surface used by skill-resolver.ts
// ---------------------------------------------------------------------------

/**
 * Fetch all script-carrying skills from every registered marketplace.
 *
 * Iterates `MARKETPLACES`, creates a provider via `providerFor`, calls
 * `listSkills()` on each.  Results are concatenated and de-duplicated by `id`
 * (first occurrence wins, so earlier entries in `MARKETPLACES` take priority).
 *
 * Returns an empty array if all marketplaces fail.
 */
export async function buildMarketplaceSkillsIndex(): Promise<SkillSummary[]> {
  const providers = MARKETPLACES.map((entry) => {
    try {
      return providerFor(entry);
    } catch (err) {
      console.warn('[da-agent:marketplace] skipping unknown provider type:', err);
      return null;
    }
  }).filter((p): p is SkillMarketplaceProvider => p !== null);

  const perProvider = await Promise.all(
    providers.map(async (provider) => {
      try {
        return await provider.listSkills();
      } catch (err) {
        console.warn('[da-agent:marketplace] provider.listSkills() threw unexpectedly:', err);
        return [] as SkillSummary[];
      }
    }),
  );

  // Flatten + dedupe by id (first occurrence wins).
  const seen = new Set<string>();
  const merged: SkillSummary[] = [];
  for (const skills of perProvider) {
    for (const skill of skills) {
      if (!seen.has(skill.id)) {
        seen.add(skill.id);
        merged.push(skill);
      }
    }
  }
  return merged;
}

/**
 * Append marketplace script-skills to an existing index.
 *
 * Local prose skills are never displaced.  Marketplace skills are appended
 * at the end so local skills always appear first in the system prompt.
 *
 * If the marketplace fetch fails, the original index is returned unchanged.
 */
export async function mergeMarketplaceSkillsIntoIndex(index: SkillsIndex): Promise<SkillsIndex> {
  const marketplaceSkills = await buildMarketplaceSkillsIndex();
  if (marketplaceSkills.length === 0) return index;
  return {
    ...index,
    skills: [...index.skills, ...marketplaceSkills],
  };
}
