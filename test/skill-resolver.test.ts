import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveSkillsAndAgent } from '../src/skill-resolver.js';
import type { ChatContext } from '../src/chat-context.js';

vi.mock('../src/skills/folder-loader.js', () => ({
  loadSkillsIndexFromFolders: vi.fn(async () => ({
    skills: [{ id: 'seo', title: 'Run SEO checks before publish' }],
    source: 'folder',
  })),
  loadSkillBodyFromFolder: vi.fn(async (_c: unknown, _o: string, _s: string, id: string) =>
    id === 'seo' ? '# SEO Skill\nCheck headings.' : null,
  ),
  LEGACY_SKILLS_SHEET_FALLBACK_ENABLED: true,
}));

vi.mock('../src/marketplace/gh-skills.js', () => ({
  mergeMarketplaceSkillsIntoIndex: vi.fn(async (index: unknown) => index),
}));

vi.mock('../src/agents/loader.js', () => ({
  loadAgentPreset: vi.fn(async (_c: unknown, _o: string, _s: string, agentId: string) =>
    agentId === 'brand'
      ? { id: 'brand', name: 'Brand', description: 'desc', systemPrompt: 'prompt', skills: ['seo'] }
      : null,
  ),
}));

function mockCtx(overrides?: Partial<ChatContext>): ChatContext {
  return {
    pageContext: { org: 'adobe', site: 'docs', path: '/index.html' },
    imsToken: 'tok',
    daOrigin: 'https://admin.da.live',
    sourceUrl: 'https://admin.da.live/source/adobe/docs/index.html',
    adminClient: { getSiteConfig: vi.fn() } as unknown as ChatContext['adminClient'],
    edsClient: null,
    collab: null,
    attachmentMap: new Map(),
    attachments: [],
    projectMemory: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSkillsAndAgent', () => {
  it('loads skills index when adminClient and pageContext available', async () => {
    const result = await resolveSkillsAndAgent(mockCtx(), {});
    expect(result.skillsIndex).not.toBeNull();
    expect(result.skillsIndex!.skills).toHaveLength(1);
  });

  it('returns null skillsIndex without adminClient', async () => {
    const result = await resolveSkillsAndAgent(mockCtx({ adminClient: null }), {});
    expect(result.skillsIndex).toBeNull();
  });

  it('returns null skillsIndex without pageContext', async () => {
    const result = await resolveSkillsAndAgent(mockCtx({ pageContext: undefined }), {});
    expect(result.skillsIndex).toBeNull();
  });

  it('loads agent preset when agentId provided', async () => {
    const result = await resolveSkillsAndAgent(mockCtx(), { agentId: 'brand' });
    expect(result.activeAgent).not.toBeNull();
    expect(result.activeAgent!.name).toBe('Brand');
  });

  it('loads agent skill contents', async () => {
    const result = await resolveSkillsAndAgent(mockCtx(), { agentId: 'brand' });
    expect(result.agentSkillContents).toHaveProperty('seo');
    expect(result.agentSkillContents.seo).toContain('SEO Skill');
  });

  it('returns null agent without agentId', async () => {
    const result = await resolveSkillsAndAgent(mockCtx(), {});
    expect(result.activeAgent).toBeNull();
  });

  it('returns null agent for unknown agentId', async () => {
    const result = await resolveSkillsAndAgent(mockCtx(), { agentId: 'unknown' });
    expect(result.activeAgent).toBeNull();
  });

  it('loads explicitly requested skills', async () => {
    const result = await resolveSkillsAndAgent(mockCtx(), { requestedSkills: ['seo'] });
    expect(result.requestedSkillContents).toHaveProperty('seo');
    expect(result.requestedSkillContents.seo).toContain('SEO Skill');
  });

  it('reuses agent skill content for requested skills', async () => {
    const result = await resolveSkillsAndAgent(mockCtx(), {
      agentId: 'brand',
      requestedSkills: ['seo'],
    });
    expect(result.requestedSkillContents.seo).toBe(result.agentSkillContents.seo);
  });

  it('returns empty requestedSkillContents when no skills requested', async () => {
    const result = await resolveSkillsAndAgent(mockCtx(), {});
    expect(Object.keys(result.requestedSkillContents)).toHaveLength(0);
  });

  it('handles missing requested skill gracefully', async () => {
    const result = await resolveSkillsAndAgent(mockCtx(), { requestedSkills: ['nonexistent'] });
    expect(result.requestedSkillContents).not.toHaveProperty('nonexistent');
  });
});
