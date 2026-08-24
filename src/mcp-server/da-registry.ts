/**
 * DA Content MCP tool registry (/mcp/da).
 *
 * Exposes DA Admin content operations as MCP tools — the full `da-tools`
 * built-in bundle advertised by the Skills Editor (18 tools). Claude Managed
 * Agents (CMA) orchestrates the loop; da-agent executes each tool.
 *
 * Tools marked [REQUIRES_APPROVAL] must not be called until the user has
 * explicitly confirmed the proposed action. Under CMA the native approval
 * gate (permission_policy: always_ask) enforces this; the prompt marker is
 * the soft signal that mirrors the native Vercel-SDK `needsApproval` tools.
 *
 * This surface is AO-agnostic and CMA-first: it wraps DAAdminClient and the
 * skills/agents/memory loaders only — no chat loop, no A2A, no AO context.
 */

import { DAAdminClient } from '../da-admin/client.js';
import { ensureHtmlExtension } from '../tools/utils.js';
import { saveSkillContent } from '../skills/loader.js';
import { loadSkillBodyFromFolder } from '../skills/folder-loader.js';
import { listAgentPresets, saveAgentPreset, type AgentPreset } from '../agents/loader.js';
import { saveProjectMemory } from '../memory/loader.js';
import { createCollabClient, type CollabClient } from '../collab-client.js';
import { extractImsUserId } from '../auth.js';
import type { MCPToolDef, MCPToolRegistry } from './handler.js';

/**
 * Optional da-collab wiring. When present, content reads/writes to a document that
 * is currently open in someone's canvas editor are routed through da-collab (which
 * persists to da-admin) instead of writing da-admin directly — otherwise a direct
 * da-admin write would be clobbered by the live collaborative session. When absent,
 * or when no human has the doc open, operations use da-admin directly (unchanged).
 */
export interface DAMCPRegistryOptions {
  dacollab?: Fetcher;
  daOrigin?: string;
}

const orgRepo = {
  org: { type: 'string', description: 'Organization name (e.g. "adobe")' },
  repo: { type: 'string', description: 'Repository / site name (e.g. "my-site")' },
} as const;

const DA_TOOLS: MCPToolDef[] = [
  {
    name: 'content_list',
    description:
      'List all sources and directories in a DA repository at a given path. ' +
      'Returns files and folders with their metadata. Use to explore site structure.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        path: {
          type: 'string',
          description: 'Path within the repository (e.g. "docs/guides"). Leave empty for root.',
        },
      },
      required: ['org', 'repo'],
    },
  },
  {
    name: 'content_read',
    description:
      'Read the HTML content of a specific page from a DA repository. ' +
      'Returns raw HTML and metadata. Use to inspect existing content before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        path: { type: 'string', description: 'Path to the file (e.g. "docs/index")' },
      },
      required: ['org', 'repo', 'path'],
    },
  },
  {
    name: 'content_create',
    description:
      '[REQUIRES_APPROVAL] Create a new page in a DA repository. ' +
      'Do not call until the user has explicitly approved the proposed content. ' +
      'Content must be a plain HTML string starting with <body> and ending with </body>, ' +
      'with all page content wrapped in <main>. Separate sections with <hr>. Represent EDS blocks as ' +
      '<div class="block-name"> where each row is a child <div> and each column a nested <div>. ' +
      'Use semantic HTML; never use inline styles or <table> for layout.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        path: { type: 'string', description: 'Destination path for the new file' },
        content: { type: 'string', description: 'Full HTML content, starting with <body>' },
        contentType: {
          type: 'string',
          description: 'Optional content type (default "text/html")',
        },
        humanReadableSummary: {
          type: 'string',
          description: 'Plain-language summary of the page (shown to user for approval)',
        },
      },
      required: ['org', 'repo', 'path', 'content', 'humanReadableSummary'],
    },
  },
  {
    name: 'content_update',
    description:
      '[REQUIRES_APPROVAL] Update an existing page in a DA repository with new content. ' +
      'Do not call until the user has explicitly approved the proposed changes. ' +
      'Content must be a plain HTML string starting with <body> and ending with </body>. ' +
      'Same HTML conventions as content_create apply. Always set humanReadableSummary describing what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        path: { type: 'string', description: 'Path to the existing file to update' },
        content: { type: 'string', description: 'New full HTML content, starting with <body>' },
        contentType: { type: 'string', description: 'Optional content type' },
        humanReadableSummary: {
          type: 'string',
          description: 'Plain-language description of what changed (for user approval)',
        },
      },
      required: ['org', 'repo', 'path', 'content', 'humanReadableSummary'],
    },
  },
  {
    name: 'content_delete',
    description:
      '[REQUIRES_APPROVAL] Delete a page from a DA repository. This cannot be undone. ' +
      'Do not call until the user has explicitly confirmed the deletion.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        path: { type: 'string', description: 'Path to the file to delete' },
      },
      required: ['org', 'repo', 'path'],
    },
  },
  {
    name: 'content_copy',
    description:
      'Copy content from one location to another within a DA repository. ' +
      'Creates a duplicate of the source at the destination.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        sourcePath: { type: 'string', description: 'Path to the source file to copy from' },
        destinationPath: { type: 'string', description: 'Path where the file should be copied to' },
      },
      required: ['org', 'repo', 'sourcePath', 'destinationPath'],
    },
  },
  {
    name: 'content_move',
    description:
      '[REQUIRES_APPROVAL] Move content from one location to another within a DA repository. ' +
      'The source file will be removed. Do not call until the user has confirmed the move.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        sourcePath: { type: 'string', description: 'Path to the source file to move from' },
        destinationPath: { type: 'string', description: 'Path where the file should be moved to' },
      },
      required: ['org', 'repo', 'sourcePath', 'destinationPath'],
    },
  },
  {
    name: 'content_version_create',
    description:
      'Create a version (snapshot) of a source document in a DA repository. ' +
      'Use to snapshot the current state of a file before making changes.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        path: { type: 'string', description: 'Path to the file (e.g. "docs/my-page")' },
        label: { type: 'string', description: 'Optional label for the version' },
      },
      required: ['org', 'repo', 'path'],
    },
  },
  {
    name: 'content_version_list',
    description:
      'Get version history for a source file in a DA repository. ' +
      'Returns a list of versions with timestamps and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        path: { type: 'string', description: 'Path to the file' },
      },
      required: ['org', 'repo', 'path'],
    },
  },
  {
    name: 'content_media',
    description:
      'Lookup media references in a DA repository. ' +
      'Returns the binary media content as base64 with its MIME type.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        mediaPath: { type: 'string', description: 'Path to the media file' },
      },
      required: ['org', 'repo', 'mediaPath'],
    },
  },
  {
    name: 'content_fragment',
    description:
      'Lookup fragment references in a DA repository. Returns information about content fragments.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        fragmentPath: { type: 'string', description: 'Path to the fragment' },
      },
      required: ['org', 'repo', 'fragmentPath'],
    },
  },
  {
    name: 'content_upload',
    description:
      'Upload an image or media file to a DA repository. ' +
      'For page-related images use a dot-prefixed folder named after the page ' +
      '(e.g. page "docs/my-page.html" → image "docs/.my-page/image.png"). ' +
      'For standalone uploads use the "media" folder (e.g. "media/image.png").',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        path: { type: 'string', description: 'Destination path for the media file' },
        base64Data: { type: 'string', description: 'Base64-encoded file content' },
        mimeType: { type: 'string', description: 'MIME type (e.g. "image/png", "image/jpeg")' },
        fileName: { type: 'string', description: 'Original filename including extension' },
      },
      required: ['org', 'repo', 'path', 'base64Data', 'mimeType', 'fileName'],
    },
  },
  {
    name: 'da_get_skill',
    description:
      'Read the full instructions of a skill by its ID. Skills are markdown documents stored ' +
      'at `.da/skills/<id>/skill.md` describing workflows, brand guidelines, or task instructions. ' +
      'Frontmatter is stripped; the response is pure instruction prose.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        skillId: { type: 'string', description: 'The skill identifier (e.g. "brand-voice")' },
      },
      required: ['org', 'repo', 'skillId'],
    },
  },
  {
    name: 'da_create_skill',
    description:
      'Create or update a skill in the DA site config `skills` sheet (skillId + markdown content). ' +
      'Call whenever the user asks to create, save, or persist a skill. Skills can reference MCP tools ' +
      'by name (e.g. mcp__<serverId>__<toolName>). Written as a draft.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        skillId: {
          type: 'string',
          description: 'Skill identifier (lowercase alphanumeric with hyphens, e.g. "brand-voice")',
        },
        content: { type: 'string', description: 'Full markdown content of the skill' },
      },
      required: ['org', 'repo', 'skillId', 'content'],
    },
  },
  {
    name: 'da_list_agents',
    description:
      'List available agent presets. Agent presets bundle a system prompt, skills, and MCP server ' +
      'selections into a reusable persona (e.g. "SEO Agent", "Brand Voice Agent").',
    inputSchema: {
      type: 'object',
      properties: { ...orgRepo },
      required: ['org', 'repo'],
    },
  },
  {
    name: 'da_create_agent',
    description:
      '[REQUIRES_APPROVAL] Create or update an agent preset. An agent preset bundles a custom system ' +
      'prompt, a list of skill IDs, and a list of MCP server IDs into a named configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        agentId: {
          type: 'string',
          description: 'Agent identifier (lowercase alphanumeric with hyphens, e.g. "seo-agent")',
        },
        name: { type: 'string', description: 'Display name for the agent' },
        description: { type: 'string', description: 'Brief description of what this agent does' },
        systemPrompt: { type: 'string', description: 'Custom system prompt for this agent' },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Skill IDs to auto-load when this agent is active',
        },
        mcpServers: {
          type: 'array',
          items: { type: 'string' },
          description: 'MCP server IDs to use with this agent',
        },
      },
      required: ['org', 'repo', 'agentId', 'name', 'description', 'systemPrompt'],
    },
  },
  {
    name: 'da_embed_fragment',
    description:
      '[REQUIRES_APPROVAL] Embed a web fragment into a page. Reads the target page, inserts an EDS ' +
      'fragment block referencing the fragment path (before </main>), and writes the page back. ' +
      'Do not call until the user has approved the change. Set humanReadableSummary describing the embed.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        path: {
          type: 'string',
          description: 'Path to the target page the fragment is embedded into',
        },
        fragmentPath: {
          type: 'string',
          description: 'Path to the fragment to embed (e.g. "/fragments/promo")',
        },
        humanReadableSummary: {
          type: 'string',
          description: 'Plain-language description of the embed (for user approval)',
        },
      },
      required: ['org', 'repo', 'path', 'fragmentPath', 'humanReadableSummary'],
    },
  },
  {
    name: 'write_project_memory',
    description:
      'Write or update the long-lived project memory for this site. Call when you discover ' +
      'significant information about the site — its purpose, main sections, URL structure, templates, ' +
      'or content conventions. Pass the full updated markdown content each time.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgRepo,
        content: {
          type: 'string',
          description: 'Full markdown content to write to project memory',
        },
      },
      required: ['org', 'repo', 'content'],
    },
  },
];

/** EDS fragment paths are used verbatim inside an href — reject anything that
 *  isn't a safe path to prevent HTML-attribute injection. */
const SAFE_FRAGMENT_PATH = /^[A-Za-z0-9/_.-]+$/;

export function createDAMCPRegistry(
  imsToken: string,
  daadminService: Fetcher,
  options?: DAMCPRegistryOptions,
): MCPToolRegistry {
  const client = new DAAdminClient({ apiToken: imsToken, daadminService });

  /**
   * Connect to da-collab for a doc so reads/edits go through the live session (which
   * persists to da-admin) rather than touching da-admin directly. A headless MCP call
   * can't tell whether the doc is open in a canvas, so edits/reads ALWAYS route through
   * da-collab when it's available — a direct da-admin write could clobber a live session.
   * Returns null — cleaning up any connection — when da-collab is unbound or the
   * connection fails, so callers fall back to da-admin. Never throws.
   */
  async function connectCollab(
    org: string,
    repo: string,
    pathWithExt: string,
  ): Promise<CollabClient | null> {
    if (!options?.dacollab || !options.daOrigin) return null;
    try {
      const sourceUrl = `${options.daOrigin}/source/${org}/${repo}/${pathWithExt}`;
      const userName = extractImsUserId(imsToken) ?? org;
      const collab = await createCollabClient(sourceUrl, imsToken, userName, options.dacollab);
      if (!collab) return null;
      if (!collab.isConnected) {
        collab.disconnect();
        return null;
      }
      return collab;
    } catch {
      return null;
    }
  }

  return {
    tools: DA_TOOLS,
    execute: async (name: string, args: Record<string, unknown>) => {
      const org = args.org as string;
      const repo = args.repo as string;

      switch (name) {
        case 'content_list': {
          const path = (args.path as string | undefined) ?? '';
          return client.listSources(org, repo, path);
        }

        case 'content_read': {
          const path = ensureHtmlExtension(args.path as string);
          // Read through da-collab so we see the live (possibly unsaved) content when the
          // doc is open; falls back to da-admin (source of truth) if collab is unavailable.
          const collab = await connectCollab(org, repo, path);
          if (collab) {
            try {
              const content = collab.getContent();
              if (content != null) return { path, content, source: 'collab' };
            } finally {
              collab.disconnect();
            }
          }
          return client.getSource(org, repo, path);
        }

        case 'content_create':
          return client.createSource(
            org,
            repo,
            ensureHtmlExtension(args.path as string),
            args.content as string,
            (args.contentType as string | undefined) ?? 'text/html',
          );

        case 'content_update': {
          const path = ensureHtmlExtension(args.path as string);
          const content = args.content as string;
          const contentType = (args.contentType as string | undefined) ?? 'text/html';
          // Apply the edit to the live da-collab session (which persists to da-admin) so an
          // open editor stays consistent and a live session can't clobber the write; falls
          // back to a direct da-admin write only if da-collab is unavailable.
          const collab = await connectCollab(org, repo, path);
          if (collab) {
            try {
              collab.applyContent(content);
              await client.updateSource(org, repo, path, content, contentType, {
                initiator: 'collab',
              });
              return { path, source: 'collab', updated: true };
            } finally {
              collab.disconnect();
            }
          }
          return client.updateSource(org, repo, path, content, contentType);
        }

        case 'content_delete':
          return client.deleteSource(org, repo, ensureHtmlExtension(args.path as string));

        case 'content_copy':
          return client.copyContent(
            org,
            repo,
            ensureHtmlExtension(args.sourcePath as string),
            ensureHtmlExtension(args.destinationPath as string),
          );

        case 'content_move':
          return client.moveContent(
            org,
            repo,
            ensureHtmlExtension(args.sourcePath as string),
            ensureHtmlExtension(args.destinationPath as string),
          );

        case 'content_version_create':
          return client.createVersion(
            org,
            repo,
            ensureHtmlExtension(args.path as string),
            args.label as string | undefined,
          );

        case 'content_version_list':
          return client.getVersions(org, repo, ensureHtmlExtension(args.path as string));

        case 'content_media':
          return client.lookupMedia(org, repo, args.mediaPath as string);

        case 'content_fragment':
          return client.lookupFragment(org, repo, args.fragmentPath as string);

        case 'content_upload':
          return client.uploadMedia(
            org,
            repo,
            args.path as string,
            args.base64Data as string,
            args.mimeType as string,
            args.fileName as string,
          );

        case 'da_get_skill': {
          const skillId = args.skillId as string;
          const content = await loadSkillBodyFromFolder(client, org, repo, skillId);
          if (!content) return { error: `Skill "${skillId}" not found` };
          return { skillId, content };
        }

        case 'da_create_skill': {
          const skillId = args.skillId as string;
          const result = await saveSkillContent(
            client,
            org,
            repo,
            skillId,
            args.content as string,
            {
              status: 'draft',
            },
          );
          if (!result.success) return { error: result.error };
          return { skillId, saved: true };
        }

        case 'da_list_agents':
          return listAgentPresets(client, org, repo);

        case 'da_create_agent': {
          const agentId = args.agentId as string;
          const preset: AgentPreset = {
            name: args.name as string,
            description: args.description as string,
            systemPrompt: args.systemPrompt as string,
            skills: (args.skills as string[] | undefined) ?? [],
            mcpServers: (args.mcpServers as string[] | undefined) ?? [],
          };
          const result = await saveAgentPreset(client, org, repo, agentId, preset);
          if (!result.success) return { error: result.error };
          return { agentId, saved: true };
        }

        case 'da_embed_fragment': {
          const path = ensureHtmlExtension(args.path as string);
          const rawFragment = String(args.fragmentPath as string);
          const ref = `/${rawFragment.replace(/^\/+/, '').replace(/\.html$/i, '')}`;
          if (!SAFE_FRAGMENT_PATH.test(ref)) {
            return { error: `Invalid fragmentPath: "${rawFragment}"` };
          }
          const source = await client.getSource(org, repo, path);
          const html = typeof source === 'string' ? source : (source?.content ?? '');
          if (!html) return { error: `Page "${path}" not found or empty` };
          const block = `<div class="fragment"><div><div><a href="${ref}">${ref}</a></div></div></div>`;
          let updated: string;
          if (/<\/main>/i.test(html)) {
            updated = html.replace(/<\/main>/i, `${block}</main>`);
          } else if (/<\/body>/i.test(html)) {
            updated = html.replace(/<\/body>/i, `${block}</body>`);
          } else {
            updated = html + block;
          }
          return client.updateSource(org, repo, path, updated, 'text/html');
        }

        case 'write_project_memory': {
          const result = await saveProjectMemory(client, org, repo, args.content as string);
          if (!result.success) return { error: result.error };
          return { saved: true };
        }

        default:
          throw new Error(`Unknown DA tool: ${name}`);
      }
    },
  };
}
