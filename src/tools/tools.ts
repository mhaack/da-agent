/**
 * DA Tools
 * Vercel AI SDK tool definitions wrapping DAAdminClient
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { DAAdminClient } from '../da-admin/client';
import type { DAAPIError } from '../da-admin/types';
import { ensureHtmlExtension } from './utils';

function isDAAPIError(e: unknown): e is DAAPIError {
  return typeof e === 'object' && e !== null && 'status' in e && 'message' in e;
}

function withLogging<T extends Record<string, { execute?:(...args: any[]) => any }>>(tools: T): T {
  for (const [name, t] of Object.entries(tools)) {
    const orig = t.execute;
    if (orig) {
      t.execute = (...args: any[]) => {
        console.log(`[tool] ${name}`, JSON.stringify(args[0]));
        return orig(...args);
      };
    }
  }
  return tools;
}

export function createDATools(client: DAAdminClient) {
  return withLogging({
    da_list_sources: tool({
      description:
        'List all sources and directories in a DA repository at a given path. Returns a list of files and folders with their metadata.',
      inputSchema: z.object({
        org: z.string().describe('Organization name (e.g., "adobe")'),
        repo: z.string().describe('Repository name (e.g., "my-docs")'),
        path: z
          .string()
          .optional()
          .describe(
            'Optional path within repository (e.g., "docs/guides"). Leave empty for root.',
          ),
      }),
      execute: async ({ org, repo, path }) => {
        try {
          return await client.listSources(org, repo, path);
        } catch (e) {
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_get_source: tool({
      description:
        'Get the content of a specific source file from a DA repository. Returns the file content and metadata.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z
          .string()
          .describe(
            'Path to the file within the repository (e.g., "docs/index.md")',
          ),
      }),
      execute: async ({ org, repo, path }) => {
        try {
          return await client.getSource(org, repo, ensureHtmlExtension(path));
        } catch (e) {
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_create_source: tool({
      description:
        'Create a new source file in a DA repository with the specified content. '
        + 'Content MUST be a plain HTML string (no CDATA, no markdown fences) starting with <body> and ending with </body>, '
        + 'with all page content wrapped in <main> inside <body>. '
        + 'Separate sections with <hr>, represent EDS blocks as <div class="block-name"> elements where each '
        + 'content row is a child <div> and each column a nested <div>, use proper semantic HTML elements '
        + '(headings, p, ul/ol/li, a, img with alt), and never use inline styles or <table> tags for blocks.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z
          .string()
          .describe(
            'Path where the new file should be created (e.g., "docs/new-page.md")',
          ),
        content: z.string().describe('Content of the new file'),
        contentType: z
          .string()
          .optional()
          .describe(
            'Optional content type (e.g., "text/markdown", "text/html")',
          ),
      }),
      needsApproval: async () => true,
      execute: async ({
        org, repo, path, content, contentType,
      }) => {
        try {
          return await client.createSource(
            org,
            repo,
            ensureHtmlExtension(path),
            content,
            contentType,
          );
        } catch (e) {
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_update_source: tool({
      description:
        'Update an existing source file in a DA repository with new content. '
        + 'Content MUST be a plain HTML string (no CDATA, no markdown fences) starting with <body> and ending with </body>, '
        + 'with all page content wrapped in <main> inside <body>. '
        + 'Separate sections with <hr>, represent EDS blocks as <div class="block-name"> elements where each '
        + 'content row is a child <div> and each column a nested <div>, use proper semantic HTML elements '
        + '(headings, p, ul/ol/li, a, img with alt), and never use inline styles or <table> tags for blocks.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z.string().describe('Path to the file to update'),
        content: z.string().describe('New content for the file'),
        contentType: z.string().optional().describe('Optional content type'),
      }),
      needsApproval: async () => true,
      execute: async ({
        org, repo, path, content, contentType,
      }) => {
        try {
          return await client.updateSource(
            org,
            repo,
            ensureHtmlExtension(path),
            content,
            contentType,
          );
        } catch (e) {
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_delete_source: tool({
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
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_copy_content: tool({
      description:
        'Copy content from one location to another within a DA repository. Creates a duplicate of the source at the destination.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        sourcePath: z.string().describe('Path to the source file to copy from'),
        destinationPath: z
          .string()
          .describe('Path where the file should be copied to'),
      }),
      execute: async ({
        org, repo, sourcePath, destinationPath,
      }) => {
        try {
          return await client.copyContent(
            org,
            repo,
            ensureHtmlExtension(sourcePath),
            ensureHtmlExtension(destinationPath),
          );
        } catch (e) {
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_move_content: tool({
      description:
        'Move content from one location to another within a DA repository. The source file will be removed.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        sourcePath: z.string().describe('Path to the source file to move from'),
        destinationPath: z
          .string()
          .describe('Path where the file should be moved to'),
      }),
      needsApproval: async () => true,
      execute: async ({
        org, repo, sourcePath, destinationPath,
      }) => {
        try {
          return await client.moveContent(
            org,
            repo,
            ensureHtmlExtension(sourcePath),
            ensureHtmlExtension(destinationPath),
          );
        } catch (e) {
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_create_version: tool({
      description:
        'Create a version of a source document or sheet in a DA repository. Use this to snapshot the current state of a file before making changes.',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z
          .string()
          .describe(
            'Path to the file including extension (e.g., "docs/my-page.html")',
          ),
        label: z.string().optional().describe('Optional label for the version'),
      }),
      execute: async ({
        org, repo, path, label,
      }) => {
        try {
          return await client.createVersion(org, repo, ensureHtmlExtension(path), label);
        } catch (e) {
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_get_versions: tool({
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
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_lookup_media: tool({
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
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_lookup_fragment: tool({
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
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),

    da_upload_media: tool({
      description:
        'Upload an image or media file to a DA repository using base64-encoded data. '
        + 'When uploading images referenced in a page (e.g. during page creation or update), '
        + 'place the image in a child folder named after the page, sibling to the page file '
        + '(e.g. page at "docs/my-page.html" → image at "docs/.my-page/image.png" with the folder name with a leading dot). '
        + 'For standalone media uploads unrelated to a specific page, use the "media" folder '
        + '(e.g. "media/image.png").',
      inputSchema: z.object({
        org: z.string().describe('Organization name'),
        repo: z.string().describe('Repository name'),
        path: z
          .string()
          .describe(
            'Destination path for the media file. '
              + 'For page-related images use a dot-prefixed folder named after the page: "docs/.my-page/image.png". '
              + 'For standalone uploads use the media folder: "media/image.png".',
          ),
        base64Data: z.string().describe('Base64-encoded file content'),
        mimeType: z
          .string()
          .describe('MIME type of the file (e.g., "image/png", "image/jpeg")'),
        fileName: z
          .string()
          .describe('Original filename including extension (e.g., "photo.jpg")'),
      }),
      execute: async ({
        org, repo, path, base64Data, mimeType, fileName,
      }) => {
        try {
          return await client.uploadMedia(
            org,
            repo,
            path,
            base64Data,
            mimeType,
            fileName,
          );
        } catch (e) {
          if (isDAAPIError(e)) return { error: e.message, status: e.status };
          return { error: String(e) };
        }
      },
    }),
  });
}
