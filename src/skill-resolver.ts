/**
 * Skill + agent loading extracted from handleChat.
 * Resolves the skills index, agent preset, agent skill contents,
 * and explicitly requested skill contents.
 */

import { loadSkillsIndexFromFolders, loadSkillBodyFromFolder } from './skills/folder-loader.js';
import type { SkillsIndex } from './skills/loader.js';
import { mergeMarketplaceSkillsIntoIndex } from './marketplace/gh-skills.js';
import { loadAgentPreset } from './agents/loader.js';
import { getBuiltinPreset } from './agents/builtin-presets.js';
import type { AgentPreset } from './agents/loader.js';
import type { EarlyChatContext } from './chat-context.js';

export interface ResolvedSkills {
  skillsIndex: SkillsIndex | null;
  activeAgent: AgentPreset | null;
  agentSkillContents: Record<string, string>;
  requestedSkillContents: Record<string, string>;
}

/**
 * Resolve skill index, agent preset, and skill contents.
 * Only needs adminClient + pageContext so it can run before collab resolves.
 */
export async function resolveSkillsAndAgent(
  ctx: Pick<EarlyChatContext, 'adminClient' | 'pageContext'>,
  body: { agentId?: string; requestedSkills?: string[] },
): Promise<ResolvedSkills> {
  const { adminClient, pageContext } = ctx;
  const { agentId, requestedSkills } = body;

  let skillsIndex: SkillsIndex | null = null;
  if (adminClient && pageContext) {
    try {
      const folderIndex = await loadSkillsIndexFromFolders(
        adminClient,
        pageContext.org,
        pageContext.site,
      );
      // Append marketplace script-skills. Folder skills are prose-only (no
      // execution metadata). If the marketplace is unreachable the index is
      // returned unchanged.
      skillsIndex = await mergeMarketplaceSkillsIntoIndex(folderIndex);
    } catch (err) {
      console.warn('[da-agent] failed to load skills index:', err);
    }
  }

  let activeAgent: AgentPreset | null = null;
  let agentSkillContents: Record<string, string> = {};
  if (agentId) {
    if (adminClient && pageContext) {
      try {
        activeAgent = await loadAgentPreset(
          adminClient,
          pageContext.org,
          pageContext.site,
          agentId,
        );
        if (activeAgent && activeAgent.skills.length > 0) {
          const entries = await Promise.all(
            activeAgent.skills.map(async (sid) => {
              try {
                const content = await loadSkillBodyFromFolder(
                  adminClient,
                  pageContext.org,
                  pageContext.site,
                  sid,
                );
                return content ? ([sid, content] as const) : null;
              } catch {
                return null;
              }
            }),
          );
          agentSkillContents = Object.fromEntries(entries.filter(Boolean) as [string, string][]);
        }
      } catch (err) {
        console.warn('[da-agent] failed to load agent preset:', err);
      }
    }
    if (!activeAgent) {
      activeAgent = getBuiltinPreset(agentId);
    }
  }

  let requestedSkillContents: Record<string, string> = {};
  if (requestedSkills && requestedSkills.length > 0) {
    if (adminClient && pageContext) {
      const entries = await Promise.all(
        requestedSkills.map(async (sid) => {
          if (agentSkillContents[sid]) return [sid, agentSkillContents[sid]] as const;
          try {
            const content = await loadSkillBodyFromFolder(
              adminClient,
              pageContext.org,
              pageContext.site,
              sid,
            );
            return content ? ([sid, content] as const) : null;
          } catch {
            return null;
          }
        }),
      );
      const loaded = Object.fromEntries(entries.filter(Boolean) as [string, string][]);
      requestedSkillContents = { ...requestedSkillContents, ...loaded };
    }
  }

  return { skillsIndex, activeAgent, agentSkillContents, requestedSkillContents };
}
