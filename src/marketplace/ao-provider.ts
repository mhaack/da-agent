/**
 * Adobe Online (AO) marketplace provider — STUB.
 *
 * This is a compile- and test-time placeholder that implements
 * `SkillMarketplaceProvider` with canned data.  It exists to prove that the
 * interface is swappable: any backend (GitHub, AO, local, ...) can be dropped
 * in without touching skill-resolver or gh-skills.
 *
 * Replace the canned data with real AO API calls once the AO endpoint is
 * available.
 */

import type { SkillManifest, SkillMarketplaceProvider } from './provider.js';
import type { SkillSummary } from '../skills/loader.js';

/** Canned skill used in conformance tests and as a smoke-test sentinel. */
const STUB_SKILLS: SkillSummary[] = [
  {
    id: 'ao-stub-skill',
    title: 'AO Stub Skill',
    execution: {
      entry: 'run',
      runtimes: ['js'],
      capabilities: [],
      timeoutMs: 5000,
      dependencies: [],
    },
    source: 'marketplace',
  },
];

export class AOMarketplaceProvider implements SkillMarketplaceProvider {
  async listSkills(): Promise<SkillSummary[]> {
    // TODO: replace with real AO API call.
    return STUB_SKILLS;
  }

  async getSkillManifest(id: string): Promise<SkillManifest | null> {
    const skill = STUB_SKILLS.find((s) => s.id === id);
    if (!skill || !skill.execution) return null;
    return { id: skill.id, title: skill.title, execution: skill.execution };
  }

  async getScript(
    id: string,
    _runtime: string,
  ): Promise<{ source: string } | { url: string } | null> {
    const skill = STUB_SKILLS.find((s) => s.id === id);
    if (!skill) return null;
    // Stub returns inline source so tests don't need network access.
    return { source: `/* AO stub script for ${id} */` };
  }
}
