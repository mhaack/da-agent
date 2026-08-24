/**
 * Provider interface for skill marketplaces.
 *
 * Any marketplace backend (GitHub, AO, local, etc.) implements this interface.
 * The runtime asks each registered provider for its skill list and only uses
 * skills that satisfy the contract — enabling safe, zero-regression swapping.
 */

import type { SkillExecutionMeta } from '../skills/frontmatter.js';
import type { SkillSummary } from '../skills/loader.js';

/**
 * Execution metadata and identification info for a single skill as returned by
 * a provider's index.  Re-exported from the interface module so callers do not
 * need to import from `loader.ts`.
 */
export type { SkillSummary };

/**
 * Rich per-skill metadata a provider can return for deeper inspection.
 * `SkillExecutionMeta` fields are mandatory here because `getSkillManifest`
 * is only called for skills that carry execution metadata.
 */
export interface SkillManifest {
  id: string;
  /** Human-readable title / description. */
  title: string;
  /** Full execution metadata (entry, runtimes, capabilities, timeoutMs, dependencies). */
  execution: SkillExecutionMeta;
}

/**
 * A marketplace provider vends script-carrying skills from one upstream source.
 *
 * Implementations MUST be resilient: any network or parse error should be
 * caught internally and result in an empty list / null return, never a throw
 * that would break the chat path.
 */
export interface SkillMarketplaceProvider {
  /**
   * Return all publishable skills in this marketplace.
   * Returns `[]` on any failure (network, parse, auth).
   */
  listSkills(): Promise<SkillSummary[]>;

  /**
   * Return the full manifest for one skill by id.
   * Returns `null` when the skill is not found or on any error.
   */
  getSkillManifest(id: string): Promise<SkillManifest | null>;

  /**
   * Return the script source or a URL to the script for a given skill+runtime.
   *
   * - `{ source: string }` — inline source text (preferred for small scripts)
   * - `{ url: string }` — a URL the client can fetch directly
   * - `null` — script not available for this runtime, or any error
   */
  getScript(id: string, runtime: string): Promise<{ source: string } | { url: string } | null>;
}
