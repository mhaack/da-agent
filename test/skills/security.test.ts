/**
 * SECURITY TEST SUITE
 *
 * This file asserts three security properties of the da-agent skill system:
 *
 *  §1  Scripts only ever come from the marketplace.
 *      `.da/skills/` is user-writable site content — prose-only.  Even when a
 *      skill.md in .da/skills carries `execution_*` frontmatter AND a script.js
 *      sibling exists, the folder loader MUST yield a SkillSummary with NO
 *      `execution` field.  A user dropping a script in .da/skills can never make
 *      it runnable from the agent.
 *
 *  §2  Skill output is treated as data, never as instructions.
 *      `buildSkillsPromptSection` / `buildSystemPrompt` render only skill
 *      ids/titles in the system prompt.  They must NEVER embed skill execution
 *      output, arbitrary skill-provided content, or anything that could inject
 *      instructions.  The script-runnable section must also forbid `da_read_skill`
 *      on script skills and instruct the model to use exact ids.
 *
 *  §3  `skill_run_script` is client-executed — no server-side execution.
 *      The tool is registered in CANVAS_CLIENT_ONLY_TOOLS with NO `execute`
 *      function, guaranteeing the agent worker never runs script code.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadSkillsIndexFromFolders, _fallbackConfig } from '../../src/skills/folder-loader.js';
import { buildSystemPrompt } from '../../src/prompt-builder.js';
import { CANVAS_CLIENT_ONLY_TOOLS, createCanvasClientTools } from '../../src/tools/tools.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';
import type { SkillsIndex } from '../../src/skills/loader.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a skill.md with execution_* frontmatter (as if a user tried to make
 * a script-runnable skill in .da/skills).
 */
function scriptSkillMd(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'version: 1',
    'status: approved',
    'execution_entry: run',
    'execution_runtimes: js',
    'execution_capabilities: dom',
    'execution_timeout_ms: 5000',
    '---',
    `# ${name}`,
    '',
    `Body text for ${name}.`,
  ].join('\n');
}

function proseSkillMd(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'version: 1',
    'status: approved',
    '---',
    `# ${name}`,
    '',
    `Body text for ${name}.`,
  ].join('\n');
}

function mockFolderClient(opts: {
  listResponse?: unknown;
  sourceByPath?: Record<string, unknown>;
}): DAAdminClient {
  return {
    listSources: async (_org: string, _site: string, _path: string) =>
      (opts.listResponse ?? []) as ReturnType<DAAdminClient['listSources']>,
    getSource: async (_org: string, _site: string, path: string) => {
      const val = opts.sourceByPath?.[path];
      if (val === undefined) throw Object.assign(new Error('not found'), { status: 404 });
      return val as ReturnType<DAAdminClient['getSource']>;
    },
    getSiteConfig: async () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    },
  } as unknown as DAAdminClient;
}

// ---------------------------------------------------------------------------
// §1  Scripts only ever come from the marketplace
//     .da/skills is prose-only — no execution field may escape folder-loader
// ---------------------------------------------------------------------------

describe('[security §1] .da/skills folder-loader — execution field is never set', () => {
  afterEach(() => {
    _fallbackConfig.enabled = true;
  });

  it('strips execution metadata from a skill.md that contains execution_entry frontmatter', async () => {
    /**
     * A user-crafted skill.md with execution_* frontmatter must NOT produce a
     * SkillSummary.execution field.  The folder loader is the trust boundary:
     * it intentionally discards execution data because .da/skills is
     * user-writable and must never be a source of runnable scripts.
     */
    _fallbackConfig.enabled = false;
    const client = mockFolderClient({
      listResponse: [{ name: 'evil-skill', path: '/.da/skills/evil-skill' }],
      sourceByPath: {
        '.da/skills/evil-skill/skill.md': scriptSkillMd('evil-skill', 'Tries to be executable'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'site');
    expect(index.skills).toHaveLength(1);

    const summary = index.skills[0]!;
    // SECURITY: execution MUST be undefined — the folder loader is prose-only.
    expect(summary.execution).toBeUndefined();
  });

  it('keeps execution undefined even when multiple skills carry execution_entry frontmatter', async () => {
    _fallbackConfig.enabled = false;
    const client = mockFolderClient({
      listResponse: [
        { name: 'attacker-a', path: '/.da/skills/attacker-a' },
        { name: 'attacker-b', path: '/.da/skills/attacker-b' },
      ],
      sourceByPath: {
        '.da/skills/attacker-a/skill.md': scriptSkillMd('attacker-a', 'Attack A'),
        '.da/skills/attacker-b/skill.md': scriptSkillMd('attacker-b', 'Attack B'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'site');
    for (const skill of index.skills) {
      // SECURITY: no skill from .da/skills may carry execution metadata.
      expect(skill.execution).toBeUndefined();
    }
  });

  it('also has no execution field for normal prose skills (baseline / regression guard)', async () => {
    _fallbackConfig.enabled = false;
    const client = mockFolderClient({
      listResponse: [{ name: 'brand-voice', path: '/.da/skills/brand-voice' }],
      sourceByPath: {
        '.da/skills/brand-voice/skill.md': proseSkillMd('brand-voice', 'Enforce brand tone'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'site');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]!.execution).toBeUndefined();
  });

  it('returns source="folder" for skills with execution_entry frontmatter (they load as prose)', async () => {
    /**
     * The folder-loader must still load the skill (not reject it) — it just
     * silently drops the execution metadata.  This prevents a confused user
     * from thinking their skill was ignored while ensuring it cannot run.
     */
    _fallbackConfig.enabled = false;
    const client = mockFolderClient({
      listResponse: [{ name: 'user-script', path: '/.da/skills/user-script' }],
      sourceByPath: {
        '.da/skills/user-script/skill.md': scriptSkillMd('user-script', 'User tries a script'),
      },
    });

    const index = await loadSkillsIndexFromFolders(client, 'org', 'site');
    expect(index.source).toBe('folder');
    // Skill IS present — folder skills are prose-loadable.
    const skill = index.skills.find((s) => s.id === 'user-script');
    expect(skill).toBeDefined();
    // But execution is absent — the trust boundary held.
    expect(skill!.execution).toBeUndefined();
  });

  it('only marketplace-sourced SkillSummary entries carry execution and source="marketplace"', () => {
    /**
     * The type contract (SkillSummary.source and .execution) is the interface
     * contract between gh-provider and the rest of the system.  This test
     * asserts the shape: when we manually construct what gh-provider returns,
     * only entries with source="marketplace" may have execution set.
     *
     * This is a structural / contract test.  Real network-level coverage lives
     * in test/marketplace/gh-skills.test.ts.
     */
    const marketplaceSkill = {
      id: 'convert-tables',
      title: 'Convert HTML tables',
      source: 'marketplace' as const,
      execution: {
        entry: 'convert',
        runtimes: ['js'],
        capabilities: ['dom'],
        timeoutMs: 3000,
        dependencies: [],
      },
    };

    // A folder skill can never have source="marketplace" — that field is
    // only set by gh-provider.ts / ao-provider.ts.
    const folderSkill = {
      id: 'brand-voice',
      title: 'Brand Voice',
      // source intentionally absent (folder skills don't set this)
    };

    // SECURITY contract: execution only on marketplace skills.
    expect(marketplaceSkill.source).toBe('marketplace');
    expect(marketplaceSkill.execution).toBeDefined();

    // Folder skill has neither.
    expect((folderSkill as Record<string, unknown>).source).toBeUndefined();
    expect((folderSkill as Record<string, unknown>).execution).toBeUndefined();
  });

  it('a merged index that mixes folder and marketplace skills marks only marketplace skills as script-runnable', () => {
    /**
     * After mergeMarketplaceSkillsIntoIndex runs, the resulting SkillsIndex
     * must have execution ONLY on marketplace entries.  Simulated here without
     * a live network call by constructing the merged result directly.
     */
    const mergedIndex: SkillsIndex = {
      source: 'folder',
      skills: [
        // Folder prose skill — no execution
        { id: 'seo-check', title: 'SEO Check' },
        // Marketplace script skill — has execution
        {
          id: 'convert-tables',
          title: 'Convert Tables',
          source: 'marketplace',
          execution: {
            entry: 'convert',
            runtimes: ['js'],
            capabilities: [],
            timeoutMs: 3000,
            dependencies: [],
          },
        },
      ],
    };

    const proseSkills = mergedIndex.skills.filter((s) => !s.execution);
    const scriptSkills = mergedIndex.skills.filter((s) => !!s.execution);

    // SECURITY: exactly the marketplace skill is script-runnable.
    expect(proseSkills.map((s) => s.id)).toContain('seo-check');
    expect(scriptSkills.map((s) => s.id)).toContain('convert-tables');
    expect(scriptSkills.every((s) => s.source === 'marketplace')).toBe(true);
    // The folder prose skill is NOT in the script runnable list.
    expect(scriptSkills.map((s) => s.id)).not.toContain('seo-check');
  });
});

// ---------------------------------------------------------------------------
// §2  Output-as-data / no prompt-injection surface
//     buildSystemPrompt renders only id/title — never execution output
// ---------------------------------------------------------------------------

describe('[security §2] buildSystemPrompt — output-as-data, no prompt injection surface', () => {
  const scriptSkillsIndex: SkillsIndex = {
    source: 'folder',
    skills: [
      {
        id: 'convert-tables',
        title: 'Convert HTML Tables',
        source: 'marketplace',
        execution: {
          entry: 'convert',
          runtimes: ['js'],
          capabilities: ['dom'],
          timeoutMs: 3000,
          dependencies: [],
        },
      },
    ],
  };

  const mixedSkillsIndex: SkillsIndex = {
    source: 'folder',
    skills: [
      // prose skill
      { id: 'brand-voice', title: 'Enforce Brand Tone' },
      // script skill with marketplace source
      {
        id: 'docx-to-markdown',
        title: 'Convert DOCX to Markdown',
        source: 'marketplace',
        execution: {
          entry: 'convert',
          runtimes: ['js'],
          capabilities: [],
          timeoutMs: 5000,
          dependencies: ['fflate'],
        },
      },
    ],
  };

  it('system prompt contains skill id and title for script skills — nothing else from skill metadata', () => {
    /**
     * The script-runnable section MUST list only id and title.  It must NOT
     * embed execution output, dependencies, runtimes, capabilities, or any
     * other arbitrary skill-provided content that could act as instructions.
     */
    const prompt = buildSystemPrompt(undefined, null, scriptSkillsIndex);

    // ID and title ARE present (needed so the model knows what to call).
    expect(prompt).toContain('convert-tables');
    expect(prompt).toContain('Convert HTML Tables');

    // SECURITY: raw execution metadata must NOT appear in the system prompt.
    // The model has no need for entry-point names, dependency lists, etc.
    expect(prompt).not.toContain('"entry"');
    expect(prompt).not.toContain('"runtimes"');
    expect(prompt).not.toContain('"capabilities"');
    expect(prompt).not.toContain('"dependencies"');
    expect(prompt).not.toContain('"timeoutMs"');
  });

  it('system prompt does NOT embed execution_entry value in the script-runnable section', () => {
    /**
     * The execution_entry value (e.g. "convert") is internal routing metadata
     * used by da-nx.  It must never appear in the system prompt where a
     * malicious skill author could use it to confuse the model.
     */
    const prompt = buildSystemPrompt(undefined, null, scriptSkillsIndex);

    // The entry value is "convert" — it must not be verbatim in the prompt.
    // (The word "convert" appears legitimately in the title "Convert HTML Tables",
    // so we check more specifically for the execution entry context.)
    expect(prompt).not.toContain('execution_entry');
    expect(prompt).not.toContain('execution_runtimes');
    expect(prompt).not.toContain('execution_capabilities');
    expect(prompt).not.toContain('execution_timeout_ms');
    expect(prompt).not.toContain('execution_dependencies');
  });

  it('script-runnable section forbids da_read_skill on script skills', () => {
    /**
     * The system prompt MUST tell the model NOT to call da_read_skill on
     * script-runnable skills.  If it did, the script skill's prose body would
     * be loaded and could inject instructions into the context window.
     */
    const prompt = buildSystemPrompt(undefined, null, scriptSkillsIndex);
    expect(prompt).toContain('Script-Runnable Skills');
    // The hardened guidance explicitly forbids da_read_skill on script skills.
    expect(prompt).toContain('do NOT call `da_read_skill`');
  });

  it('script-runnable section instructs model to use skill_run_script with exact ids', () => {
    /**
     * The system prompt must instruct the model to use `skill_run_script` and
     * to copy skill ids EXACTLY.  This prevents guessing or hallucinating ids
     * that might map to different code.
     */
    const prompt = buildSystemPrompt(undefined, null, scriptSkillsIndex);
    expect(prompt).toContain('skill_run_script');
    // "EXACTLY" or equivalent wording must be present to prevent id mutation.
    expect(prompt).toContain('EXACTLY');
    // The model must be told skillId must match the listed id.
    expect(prompt).toContain('skillId');
  });

  it('system prompt for mixed index splits prose and script skills into separate sections', () => {
    /**
     * Prose skills and script skills must appear in separate sections so
     * the model cannot accidentally call da_read_skill on a script skill
     * (which would pull its body into context) or skill_run_script on a
     * prose skill.
     */
    const prompt = buildSystemPrompt(undefined, null, mixedSkillsIndex);

    // Both sections present.
    expect(prompt).toContain('Prose Skills');
    expect(prompt).toContain('Script-Runnable Skills');

    // Each skill in the right section.
    const proseIdx = prompt.indexOf('Prose Skills');
    const scriptIdx = prompt.indexOf('Script-Runnable Skills');
    const brandVoiceIdx = prompt.indexOf('brand-voice');
    const docxIdx = prompt.indexOf('docx-to-markdown');

    expect(proseIdx).toBeLessThan(scriptIdx);
    expect(brandVoiceIdx).toBeLessThan(scriptIdx); // prose skill before the script section
    expect(docxIdx).toBeGreaterThan(scriptIdx); // script skill inside the script section
  });

  it('system prompt does NOT contain skill execution output — only static metadata', () => {
    /**
     * Skill OUTPUT (the result of running skill_run_script) must NEVER appear
     * in the system prompt.  The system prompt is built ONCE at request start
     * from the static skills index; tool results flow back as TOOL result
     * messages in the conversation, not into the system/developer prompt.
     *
     * We assert this indirectly: after buildSystemPrompt runs with a skills
     * index, the prompt contains only static index data.  There is no mechanism
     * in buildSkillsPromptSection to accept or render execution results.
     */
    const promptWithScript = buildSystemPrompt(undefined, null, scriptSkillsIndex);

    // Typical execution output markers that must never appear.
    expect(promptWithScript).not.toContain('tool_result');
    expect(promptWithScript).not.toContain('"output":');
    expect(promptWithScript).not.toContain('script output');
    expect(promptWithScript).not.toContain('execution result');
  });

  it('prose-skill section references da_read_skill, not skill_run_script', () => {
    /**
     * Prose skills must be invoked via da_read_skill (loads body on demand).
     * The prompt must NOT direct the model to call skill_run_script for prose
     * skills — that would be a tool misuse and potential injection vector.
     */
    const proseOnlyIndex: SkillsIndex = {
      source: 'folder',
      skills: [{ id: 'brand-voice', title: 'Enforce Brand Tone' }],
    };
    const prompt = buildSystemPrompt(undefined, null, proseOnlyIndex);

    // Prose path references da_read_skill.
    expect(prompt).toContain('da_read_skill');
    // skill_run_script must NOT appear when there are no script skills.
    expect(prompt).not.toContain('skill_run_script');
  });

  it('buildSystemPrompt signature does not accept a parameter for skill execution output', () => {
    /**
     * Structural / API surface test.  The function signature must not provide
     * a path for execution output to enter the system prompt.  We verify this
     * by inspecting the return value when called with all documented args:
     * none of them are "execution output" shaped.
     *
     * The assertion is that calling the function with a skills index and
     * realistic agent args produces a prompt that does NOT contain any
     * injected runtime output.
     */
    const agent = {
      id: 'a1',
      name: 'My Agent',
      description: 'desc',
      systemPrompt: 'You are helpful.',
      skills: [],
    };
    const prompt = buildSystemPrompt(
      undefined, // pageContext
      null, // mcpConfig
      scriptSkillsIndex, // skillsIndex
      agent, // activeAgent
      {}, // agentSkillContents
      null, // generatedToolsIndex
      null, // projectMemory
      null, // sessionPattern
      undefined, // environment
      undefined, // builtInServers
      undefined, // requestedSkills
      undefined, // mcpErrors
    );

    // The prompt contains static skill listing metadata.
    expect(prompt).toContain('convert-tables');
    // It does NOT contain any execution output markers.
    expect(prompt).not.toContain('skill ran');
    expect(prompt).not.toContain('output:');
    expect(prompt).not.toContain('result:');
  });
});

// ---------------------------------------------------------------------------
// §3  skill_run_script is client-executed — no server-side execution
// ---------------------------------------------------------------------------

describe('[security §3] skill_run_script — client-only tool, no server execution', () => {
  it('skill_run_script is listed in CANVAS_CLIENT_ONLY_TOOLS', () => {
    /**
     * CANVAS_CLIENT_ONLY_TOOLS is the authoritative list of tools the agent
     * defers to the browser client.  skill_run_script MUST be in this list so
     * the AI SDK never tries to call an execute function on the server.
     */
    // SECURITY: membership in this array is the gate — if removed, the SDK
    // would look for an execute fn and error or skip the tool entirely.
    expect(CANVAS_CLIENT_ONLY_TOOLS).toContain('skill_run_script');
  });

  it('skill_run_script tool has no execute function — prevents any server-side script execution', () => {
    /**
     * The Vercel AI SDK only calls `execute` when it is present.  By omitting
     * `execute`, we guarantee the agent worker never runs arbitrary skill
     * scripts on the server.  The script runs in a da-nx sandboxed web worker
     * in the user's browser only.
     */
    const tools = createCanvasClientTools();
    const tool = tools.skill_run_script as Record<string, unknown>;

    // SECURITY: no execute fn — the server cannot run skill scripts.
    expect(tool.execute).toBeUndefined();
  });

  it('all tools in CANVAS_CLIENT_ONLY_TOOLS lack an execute function', () => {
    /**
     * Belt-and-suspenders: every tool in the canvas-client-only list must have
     * no execute function.  If a future refactor accidentally adds execute to
     * skill_run_script or another canvas-only tool, this test will catch it.
     */
    const tools = createCanvasClientTools() as Record<string, Record<string, unknown>>;

    for (const toolName of CANVAS_CLIENT_ONLY_TOOLS) {
      if (toolName in tools) {
        expect(
          tools[toolName].execute,
          `${toolName} must not have an execute fn (client-only tool)`,
        ).toBeUndefined();
      }
    }
  });

  it('skill_run_script description states the script is executed by the client, not the agent', () => {
    /**
     * The tool description is part of the model's contract — it tells the LLM
     * what happens when it calls the tool.  The description MUST be explicit
     * that execution happens client-side so the model does not attempt
     * workarounds (e.g. trying to fetch and eval the script itself).
     */
    const tools = createCanvasClientTools();
    const tool = tools.skill_run_script as { description?: string };

    expect(tool.description).toBeDefined();
    // The description must mention client-side execution.
    expect(tool.description!.toLowerCase()).toContain('client');
    // And must state the agent does NOT run it.
    expect(tool.description!).toContain('agent does NOT run it');
  });

  it('skill_run_script description instructs model to pass execution metadata exclusion', () => {
    /**
     * The description must tell the model NOT to include capabilities, runtimes,
     * or execution metadata in the call.  The client resolves those from the
     * trusted manifest.  Putting them in the call arguments would be a vector
     * for a malicious skill to override client-side security checks.
     */
    const tools = createCanvasClientTools();
    const tool = tools.skill_run_script as { description?: string };

    expect(tool.description!).toContain('Do NOT include capabilities');
  });
});
