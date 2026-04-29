/**
 * DA and EDS Tools
 * Vercel AI SDK tool definitions wrapping DAAdminClient and EDSAdminClient.
 * When in edit or canvas view with a collab session, read/write the current doc via the shared Y doc.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { DAAdminClient } from '../da-admin/client';
import type { DAAPIError } from '../da-admin/types';
import type { CollabClient } from '../collab-client';
import { loadSkillContent, saveSkillContent } from '../skills/loader';
import { listAgentPresets, saveAgentPreset } from '../agents/loader';
import type { AgentPreset } from '../agents/loader';
import { ensureHtmlExtension, isCollabEligibleView } from './utils';
import type { EDSAdminClient } from '../eds-admin/client';
import type { EDSOperationResult, EDSPublishResult, EDSToolError } from '../eds-admin/types';
import { saveProjectMemory, updateRecentPages } from '../memory/loader.js';

function recordPageChange(
  client: DAAdminClient,
  org: string,
  site: string,
  path: string,
  summary: string,
): void {
  // Fire-and-forget: record page modification without blocking the tool response
  updateRecentPages(client, org, site, { path, summary }).catch(() => {});
}

function isAPIError(e: unknown): e is DAAPIError {
  return typeof e === 'object' && e !== null && 'status' in e && 'message' in e;
}

export type PageContext = {
  org: string;
  site: string;
  path: string;
  view?: string;
};

export type DAToolsOptions = {
  pageContext?: PageContext;
  collab?: CollabClient | null;
  resolveAttachmentByRef?: (attachmentRef: string) => {
    base64Data: string;
    mimeType: string;
    fileName: string;
  } | null;
};

function useCollabForDoc(
  org: string,
  repo: string,
  path: string,
  options?: DAToolsOptions,
): boolean {
  if (!options?.pageContext || !options?.collab?.isConnected) return false;
  const { org: ctxOrg, site: ctxSite, path: ctxPath, view } = options.pageContext;
  if (!isCollabEligibleView(view)) return false;
  return (
    ctxOrg === org && ctxSite === repo && ensureHtmlExtension(ctxPath) === ensureHtmlExtension(path)
  );
}

export function createDATools(
  client: DAAdminClient | null,
  options?: DAToolsOptions & { org?: string; repo?: string },
) {
  const opts = options;
  const ctxOrg = opts?.org ?? opts?.pageContext?.org ?? '';
  const ctxRepo = opts?.repo ?? opts?.pageContext?.site ?? '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  // DA tools — only when the DA Admin client is available
  if (client) {
    tools.content_list = tool({
      description:
        'List all sources and directories in a DA repository at a given path. Returns a list of files and folders with their metadata.',
      inputSchema: z.object({
        org: z.string().describe('Organization name (e.g., "adobe")'),
        repo: z.string().describe('Repository name (e.g., "my-docs")'),
        path: z
          .string()
          .optional()
          .describe('Optional path within repository (e.g., "docs/guides"). Leave empty for root.'),
      }),
      execute: async ({ org, repo, path }) => {
        try {
          return await client.listSources(org, repo, path);
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_read = tool({
      description:
        'Get the content of a specific source file from a DA repository. Returns the file content and metadata.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z.string().describe('Path to the file within the repository (e.g., "docs/index.md")'),
      }),
      execute: async ({ org, repo, path }) => {
        try {
          if (useCollabForDoc(org, repo, path, opts) && opts?.collab) {
            const content = opts.collab.getContent();
            if (content != null) {
              return {
                path: ensureHtmlExtension(path),
                content,
                source: 'collab',
              };
            }
          }
          return await client.getSource(org, repo, ensureHtmlExtension(path));
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_create = tool({
      description:
        'Create a new source file in a DA repository with the specified content. ' +
        'Content MUST be a plain HTML string (no CDATA, no markdown fences) starting with <body> and ending with </body>, ' +
        'with all page content wrapped in <main> inside <body>. ' +
        'Separate sections with <hr>, represent EDS blocks as <div class="block-name"> elements where each ' +
        'content row is a child <div> and each column a nested <div>, use proper semantic HTML elements ' +
        '(headings, p, ul/ol/li, a, img with alt), and never use inline styles or <table> tags for blocks.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z
          .string()
          .describe('Path where the new file should be created (e.g., "docs/new-page.md")'),
        content: z.string().describe('Content of the new file'),
        contentType: z
          .string()
          .optional()
          .describe('Optional content type (e.g., "text/markdown", "text/html")'),
      }),
      needsApproval: async () => true,
      execute: async ({ org, repo, path, content, contentType }) => {
        const pathWithExt = ensureHtmlExtension(path);
        try {
          const result = await client.createSource(org, repo, pathWithExt, content, contentType);
          recordPageChange(client, org, repo, pathWithExt, 'Created new page');
          return result;
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_update = tool({
      description:
        'Update an existing source file in a DA repository with new content. ' +
        'Content MUST be a plain HTML string (no CDATA, no markdown fences) starting with <body> and ending with </body>, ' +
        'with all page content wrapped in <main> inside <body>. ' +
        'Separate sections with <hr>, represent EDS blocks as <div class="block-name"> elements where each ' +
        'content row is a child <div> and each column a nested <div>, use proper semantic HTML elements ' +
        '(headings, p, ul/ol/li, a, img with alt), and never use inline styles or <table> tags for blocks. ' +
        'Always set humanReadableSummary to a short, clear explanation of what you changed (sections added/removed, ' +
        'copy edits, block changes, etc.) so the user can approve without reading the full HTML.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z.string().describe('Path to the file to update'),
        content: z.string().describe('New content for the file'),
        humanReadableSummary: z
          .string()
          .describe(
            'Brief plain-language summary of edits for the user (bullet-style or sentences). ' +
              'No HTML; describe what changed, not the raw markup.',
          ),
        contentType: z.string().optional().describe('Optional content type'),
      }),
      needsApproval: async () => true,
      execute: async ({ org, repo, path, content, contentType, humanReadableSummary }) => {
        const pathWithExt = ensureHtmlExtension(path);
        try {
          if (useCollabForDoc(org, repo, path, opts) && opts?.collab) {
            opts.collab.applyContent(content);
            await client.updateSource(org, repo, pathWithExt, content, contentType, {
              initiator: 'collab',
            });
            opts.collab.disconnect();
            recordPageChange(client, org, repo, pathWithExt, humanReadableSummary);
            return { path: pathWithExt, source: 'collab', updated: true };
          }
          const result = await client.updateSource(org, repo, pathWithExt, content, contentType);
          recordPageChange(client, org, repo, pathWithExt, humanReadableSummary);
          return result;
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_delete = tool({
      description:
        'Delete a source file from a DA repository. Use with caution as this operation cannot be undone.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z.string().describe('Path to the file to delete'),
      }),
      needsApproval: async () => true,
      execute: async ({ org, repo, path }) => {
        try {
          return await client.deleteSource(org, repo, ensureHtmlExtension(path));
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_copy = tool({
      description:
        'Copy content from one location to another within a DA repository. Creates a duplicate of the source at the destination.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        sourcePath: z.string().describe('Path to the source file to copy from'),
        destinationPath: z.string().describe('Path where the file should be copied to'),
      }),
      execute: async ({ org, repo, sourcePath, destinationPath }) => {
        const destWithExt = ensureHtmlExtension(destinationPath);
        try {
          const result = await client.copyContent(
            org,
            repo,
            ensureHtmlExtension(sourcePath),
            destWithExt,
          );
          recordPageChange(client, org, repo, destWithExt, `Copied from ${sourcePath}`);
          return result;
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_move = tool({
      description:
        'Move content from one location to another within a DA repository. The source file will be removed.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        sourcePath: z.string().describe('Path to the source file to move from'),
        destinationPath: z.string().describe('Path where the file should be moved to'),
      }),
      needsApproval: async () => true,
      execute: async ({ org, repo, sourcePath, destinationPath }) => {
        const destWithExt = ensureHtmlExtension(destinationPath);
        try {
          const result = await client.moveContent(
            org,
            repo,
            ensureHtmlExtension(sourcePath),
            destWithExt,
          );
          recordPageChange(client, org, repo, destWithExt, `Moved from ${sourcePath}`);
          return result;
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_version_create = tool({
      description:
        'Create a version of a source document or sheet in a DA repository. Use this to snapshot the current state of a file before making changes.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z
          .string()
          .describe('Path to the file including extension (e.g., "docs/my-page.html")'),
        label: z.string().optional().describe('Optional label for the version'),
      }),
      execute: async ({ org, repo, path, label }) => {
        try {
          return await client.createVersion(org, repo, ensureHtmlExtension(path), label);
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_version_list = tool({
      description:
        'Get version history for a source file in a DA repository. Returns a list of versions with timestamps and metadata.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z.string().describe('Path to the file'),
      }),
      execute: async ({ org, repo, path }) => {
        try {
          return await client.getVersions(org, repo, ensureHtmlExtension(path));
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_media = tool({
      description:
        'Lookup media references in a DA repository. Returns information about media assets including URLs and metadata.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        mediaPath: z.string().describe('Path to the media file'),
      }),
      execute: async ({ org, repo, mediaPath }) => {
        try {
          return await client.lookupMedia(org, repo, mediaPath);
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_fragment = tool({
      description:
        'Lookup fragment references in a DA repository. Returns information about content fragments.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        fragmentPath: z.string().describe('Path to the fragment'),
      }),
      execute: async ({ org, repo, fragmentPath }) => {
        try {
          return await client.lookupFragment(org, repo, fragmentPath);
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.content_upload = tool({
      description:
        'Upload an image or media file to a DA repository. ' +
        'When the user attached files to their latest message, use attachmentRef from the provided list ' +
        'instead of sending base64Data directly. ' +
        'When uploading images referenced in a page (e.g. during page creation or update), ' +
        'place the image in a child folder named after the page, sibling to the page file ' +
        '(e.g. page at "docs/my-page.html" → image at "docs/.my-page/image.png" with the folder name with a leading dot). ' +
        'For standalone media uploads unrelated to a specific page, use the "media" folder ' +
        '(e.g. "media/image.png").',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z
          .string()
          .describe(
            'Destination path for the media file. ' +
              'For page-related images use a dot-prefixed folder named after the page: "docs/.my-page/image.png". ' +
              'For standalone uploads use the media folder: "media/image.png".',
          ),
        attachmentRef: z
          .string()
          .optional()
          .describe(
            'Reference id of a file attached by the user in their latest message. ' +
              'Prefer this over inline base64 when available.',
          ),
        base64Data: z
          .string()
          .optional()
          .describe('Base64-encoded file content. Only use when no attachmentRef is available.'),
        mimeType: z
          .string()
          .optional()
          .describe(
            'MIME type of the file (e.g., "image/png", "image/jpeg"). Required when using base64Data.',
          ),
        fileName: z
          .string()
          .optional()
          .describe(
            'Original filename including extension (e.g., "photo.jpg"). Required when using base64Data.',
          ),
      }),
      execute: async ({ org, repo, path, attachmentRef, base64Data, mimeType, fileName }) => {
        try {
          let resolvedBase64 = base64Data;
          let resolvedMime = mimeType;
          let resolvedName = fileName;
          if (attachmentRef) {
            const resolved = opts?.resolveAttachmentByRef?.(attachmentRef);
            if (!resolved) {
              return {
                error: `Attachment reference "${attachmentRef}" was not found. Ask the user to re-attach the file and try again.`,
              };
            }
            resolvedBase64 = resolved.base64Data;
            resolvedMime = resolved.mimeType;
            resolvedName = resolved.fileName;
          }
          if (!resolvedBase64 || !resolvedMime || !resolvedName) {
            return {
              error:
                'Missing upload payload. Provide attachmentRef or base64Data + mimeType + fileName.',
            };
          }
          return await client.uploadMedia(
            org,
            repo,
            path,
            resolvedBase64,
            resolvedMime,
            resolvedName,
          );
        } catch (e) {
          if (isAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    });

    tools.da_get_skill = tool({
      description:
        'Retrieve the full content of a skill by its ID. Skills are markdown documents ' +
        'containing detailed instructions for specific tasks such as brand voice, SEO ' +
        'checklists, or workflows that may reference MCP tools. Use this when the user ' +
        'asks about or wants to apply a skill listed in the Available Skills section.',
      inputSchema: z.object({
        skillId: z.string().describe('The skill identifier (e.g., "brand-voice", "seo-checklist")'),
      }),
      execute: async ({ skillId }) => {
        if (!ctxOrg) return { error: 'No organization context available' };
        try {
          const content = await loadSkillContent(client, ctxOrg, ctxRepo, skillId);
          if (!content) return { error: `Skill "${skillId}" not found` };
          return { skillId, content };
        } catch (e) {
          return { error: String(e) };
        }
      },
    });

    tools.da_create_skill = tool({
      description:
        'Create or update a skill in the DA site config `skills` sheet (key + markdown content). Call this whenever ' +
        'the user asks to create, save, write, or persist a skill — it is the primary deterministic ' +
        'path (structured skillId + content). Skills can reference MCP tools by name ' +
        '(e.g., mcp__<serverId>__<toolName>). Do not rely on chat-only prose to save skills.',
      inputSchema: z.object({
        skillId: z
          .string()
          .describe('Skill identifier (lowercase alphanumeric with hyphens, e.g., "brand-voice")'),
        content: z.string().describe('Full markdown content of the skill'),
      }),
      // Draft writes to the site config are already non-destructive for chat; requiring approval
      // only showed a generic tool-approval card and blocked the nicer [SKILL_SUGGESTION] UX.
      needsApproval: async () => false,
      execute: async ({ skillId, content }) => {
        if (!ctxOrg) return { error: 'No organization context available' };
        try {
          const result = await saveSkillContent(client, ctxOrg, ctxRepo, skillId, content, {
            status: 'draft',
          });
          if (!result.success) return { error: result.error };
          return { skillId, saved: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    });

    tools.da_list_agents = tool({
      description:
        'List available agent presets. Agent presets are named configurations that bundle ' +
        'a system prompt, skills, and MCP server selections into a reusable persona ' +
        '(e.g., "SEO Agent", "Brand Voice Agent").',
      inputSchema: z.object({}),
      execute: async () => {
        if (!ctxOrg) return { error: 'No organization context available' };
        try {
          return await listAgentPresets(client, ctxOrg, ctxRepo);
        } catch (e) {
          return { error: String(e) };
        }
      },
    });

    tools.da_create_agent = tool({
      description:
        'Create or update an agent preset. An agent preset bundles a custom system prompt, ' +
        'a list of skill IDs, and a list of MCP server IDs into a named configuration ' +
        'that can be activated for specialized workflows.',
      inputSchema: z.object({
        agentId: z
          .string()
          .describe('Agent identifier (lowercase alphanumeric with hyphens, e.g., "seo-agent")'),
        name: z.string().describe('Display name for the agent'),
        description: z.string().describe('Brief description of what this agent does'),
        systemPrompt: z.string().describe('Custom system prompt instructions for this agent'),
        skills: z
          .array(z.string())
          .optional()
          .describe('Skill IDs to auto-load when this agent is active'),
        mcpServers: z
          .array(z.string())
          .optional()
          .describe('MCP server IDs to use with this agent'),
      }),
      needsApproval: async () => true,
      execute: async ({ agentId, name, description, systemPrompt, skills, mcpServers }) => {
        if (!ctxOrg) return { error: 'No organization context available' };
        try {
          const preset: AgentPreset = {
            name,
            description,
            systemPrompt,
            skills: skills ?? [],
            mcpServers: mcpServers ?? [],
          };
          const result = await saveAgentPreset(client, ctxOrg, ctxRepo, agentId, preset);
          if (!result.success) return { error: result.error };
          return { agentId, saved: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    });

    // Memory tools write to internal agent metadata paths — no user approval needed.
    tools.write_project_memory = tool({
      description:
        'Write or update the long-lived project memory for this site. ' +
        'Call this when you discover significant information about the site — its purpose, ' +
        'main sections, URL structure, templates, or content conventions. ' +
        'Pass the full updated markdown content each time.',
      inputSchema: z.object({
        content: z
          .string()
          .min(1)
          .describe('Full markdown content to write to the project memory file.'),
      }),
      execute: async ({ content }) => {
        if (!ctxOrg || !ctxRepo) return { error: 'No org/site context available' };
        try {
          const result = await saveProjectMemory(client, ctxOrg, ctxRepo, content);
          if (!result.success) return { error: result.error };
          return { saved: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    });
  }

  return tools;
}

/**
 * Tools for compacting the conversation context window.
 * Always registered — no DA client dependency.
 */
export function createCompactTools() {
  return {
    compact_context: tool({
      description:
        'Produce and emit a compact summary of the entire conversation history to free context-window space. ' +
        'Call this whenever the compact skill is active (auto-triggered or user-requested). ' +
        'The summary must capture: active task, site context, work completed, pending items, and key facts. ' +
        'After this tool returns, briefly tell the user the conversation was compacted, then continue helping.',
      inputSchema: z.object({
        summary: z
          .string()
          .min(1)
          .describe(
            'Full markdown summary using the five required sections from the compact skill: ' +
              'Active task, Site context, Work completed, Pending items, Key facts & preferences.',
          ),
      }),
      execute: async ({ summary }) => ({ compacted: true, summary }),
    }),
  };
}

/**
 * Runs only in the canvas browser; no `execute` so the AI SDK defers results to the client.
 */
export const CANVAS_CLIENT_ONLY_TOOLS = [
  'da_bulk_preview',
  'da_bulk_publish',
  'da_bulk_delete',
] as const;

const bulkAemCanvasDialogOutputSchema = z.object({
  cancelled: z.boolean().optional(),
  okCount: z.number().optional(),
  failCount: z.number().optional(),
  message: z.string().optional(),
  results: z
    .array(
      z.object({
        path: z.string(),
        ok: z.boolean(),
        status: z.string().optional(),
        message: z.string().optional(),
        publishedUrl: z.string().optional(),
      }),
    )
    .optional(),
  publishedUrls: z.array(z.string()).optional(),
});

const bulkAemPagesInputSchema = z.object({
  pages: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'HTML page paths under the repo (e.g. "docs/guide.html" or "adobe/my-site/docs/guide.html")',
    ),
});

/**
 * Tools whose effects happen in the DA canvas UI (not on the worker).
 * Each must omit `execute` and declare `outputSchema` for typing.
 */
export function createCanvasClientTools() {
  return {
    da_bulk_preview: tool({
      description:
        "Open a bulk preview dialog in the user's browser for multiple DA pages at once. " +
        'Use when the user wants to preview several pages in the canvas workspace without opening each one manually. ' +
        'Paths may be relative to the current org/repo (e.g. "folder/page.html") or full "org/repo/path/to/page.html". ' +
        'The user confirms in the dialog; results are returned after they finish or cancel.',
      inputSchema: bulkAemPagesInputSchema,
      outputSchema: bulkAemCanvasDialogOutputSchema,
    }),
    da_bulk_publish: tool({
      description:
        "Open a bulk publish dialog in the user's browser to publish multiple DA pages to AEM live (preview then live). " +
        'Use when the user wants to publish several pages at once from the canvas workspace. ' +
        'Paths may be relative to the current org/repo or full "org/repo/path/to/page.html". ' +
        'The user runs the action in the dialog; results return after they finish or cancel, including publishedUrls ' +
        'formatted like "https://main--site--org.aem.page/path" for successful publishes.',
      inputSchema: bulkAemPagesInputSchema,
      outputSchema: bulkAemCanvasDialogOutputSchema,
    }),
    da_bulk_delete: tool({
      description:
        "Open a bulk delete dialog in the user's browser to unpublish multiple pages from AEM live (DELETE on live). " +
        'Use only when the user explicitly wants to remove published pages. ' +
        'Paths may be relative to the current org/repo or full "org/repo/path/to/page.html". ' +
        'The user confirms in the dialog; results return after they finish or cancel.',
      inputSchema: bulkAemPagesInputSchema,
      outputSchema: bulkAemCanvasDialogOutputSchema,
    }),
  };
}

export function createEDSTools(client: EDSAdminClient) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  tools.content_preview = tool({
    description:
      'Preview a page on the EDS (Edge Delivery Services) preview environment. ' +
      'Triggers a preview build so changes become visible at the preview URL. ' +
      'Use this after saving content changes to verify them before publishing.',
    inputSchema: z.object({
      org: z.string().describe('Organization name (owner)'),
      repo: z.string().describe('Repository / site name'),
      path: z
        .string()
        .describe('Page path (e.g. "/docs/index" or "/docs/index.html" — .html will be stripped)'),
    }),
    execute: async ({ org, repo, path }): Promise<EDSOperationResult | EDSToolError> => {
      try {
        return await client.preview(org, repo, path);
      } catch (e) {
        if (isAPIError(e)) return { error: e.message, status: e.status };
        return { error: String(e) };
      }
    },
  });

  tools.content_publish = tool({
    description:
      'Publish a page to the EDS (Edge Delivery Services) live environment. ' +
      'First triggers a preview build, then promotes the page to live. ' +
      'If preview fails, publishing is aborted. ' +
      'Use this to make content publicly available.',
    inputSchema: z.object({
      org: z.string().describe('Organization name (owner)'),
      repo: z.string().describe('Repository / site name'),
      path: z
        .string()
        .describe('Page path (e.g. "/docs/index" or "/docs/index.html" — .html will be stripped)'),
    }),
    execute: async ({ org, repo, path }): Promise<EDSPublishResult | EDSToolError> => {
      let preview: EDSOperationResult;
      try {
        preview = await client.preview(org, repo, path);
      } catch (e) {
        if (isAPIError(e)) return { error: e.message, status: e.status };
        return { error: String(e) };
      }
      try {
        const live = await client.publishLive(org, repo, path);
        return { preview, live };
      } catch (e) {
        if (isAPIError(e)) return { error: e.message, status: e.status };
        return { error: String(e) };
      }
    },
  });

  tools.content_unpreview = tool({
    description:
      'Remove a page from the EDS (Edge Delivery Services) preview environment. ' +
      'Use this to retract a page from preview without affecting the live site.',
    inputSchema: z.object({
      org: z.string().describe('Organization name (owner)'),
      repo: z.string().describe('Repository / site name'),
      path: z
        .string()
        .describe('Page path (e.g. "/docs/index" or "/docs/index.html" — .html will be stripped)'),
    }),
    execute: async ({ org, repo, path }): Promise<EDSOperationResult | EDSToolError> => {
      try {
        return await client.unpreview(org, repo, path);
      } catch (e) {
        if (isAPIError(e)) return { error: e.message, status: e.status };
        return { error: String(e) };
      }
    },
  });

  tools.content_unpublish = tool({
    description:
      'Unpublish a page from the EDS (Edge Delivery Services) live environment. ' +
      'Removes the page from the live site without deleting the source content.',
    inputSchema: z.object({
      org: z.string().describe('Organization name (owner)'),
      repo: z.string().describe('Repository / site name'),
      path: z
        .string()
        .describe('Page path (e.g. "/docs/index" or "/docs/index.html" — .html will be stripped)'),
    }),
    execute: async ({ org, repo, path }): Promise<EDSOperationResult | EDSToolError> => {
      try {
        return await client.unpublishLive(org, repo, path);
      } catch (e) {
        if (isAPIError(e)) return { error: e.message, status: e.status };
        return { error: String(e) };
      }
    },
  });

  return tools;
}
