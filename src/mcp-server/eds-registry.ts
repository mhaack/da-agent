/**
 * EDS MCP tool registry (/mcp/eds).
 *
 * Exposes Edge Delivery Services preview/publish operations as MCP tools —
 * the `eds-preview` built-in bundle advertised by the Skills Editor.
 * The EDSAdminClient calls public HTTPS endpoints (admin.hlx.page) —
 * no Cloudflare service binding required, so this runs standalone.
 */

import { EDSAdminClient } from '../eds-admin/client.js';
import type { MCPToolDef, MCPToolRegistry } from './handler.js';

const EDS_TOOLS: MCPToolDef[] = [
  {
    name: 'content_preview',
    description:
      'Preview a page on the EDS (Edge Delivery Services) preview environment. ' +
      'Triggers a preview build so changes become visible at the preview URL.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Organization name (owner)' },
        repo: { type: 'string', description: 'Repository / site name' },
        path: {
          type: 'string',
          description: 'Page path (e.g. "/docs/index" — .html will be stripped)',
        },
      },
      required: ['org', 'repo', 'path'],
    },
  },
  {
    name: 'content_publish',
    description:
      'Publish a page to the EDS (Edge Delivery Services) live environment. ' +
      'First triggers a preview build, then promotes the page to live.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Organization name (owner)' },
        repo: { type: 'string', description: 'Repository / site name' },
        path: {
          type: 'string',
          description: 'Page path (e.g. "/docs/index" — .html will be stripped)',
        },
      },
      required: ['org', 'repo', 'path'],
    },
  },
  {
    name: 'content_unpreview',
    description: 'Remove a page from the EDS preview environment without affecting the live site.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Organization name (owner)' },
        repo: { type: 'string', description: 'Repository / site name' },
        path: {
          type: 'string',
          description: 'Page path (e.g. "/docs/index" — .html will be stripped)',
        },
      },
      required: ['org', 'repo', 'path'],
    },
  },
  {
    name: 'content_unpublish',
    description:
      'Unpublish a page from the EDS live environment. Removes the page from the live site without deleting source content.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Organization name (owner)' },
        repo: { type: 'string', description: 'Repository / site name' },
        path: {
          type: 'string',
          description: 'Page path (e.g. "/docs/index" — .html will be stripped)',
        },
      },
      required: ['org', 'repo', 'path'],
    },
  },
];

export function createEDSMCPRegistry(imsToken: string): MCPToolRegistry {
  const client = new EDSAdminClient({ apiToken: imsToken });

  return {
    tools: EDS_TOOLS,
    execute: async (name: string, args: Record<string, unknown>) => {
      const { org, repo, path } = args as { org: string; repo: string; path: string };

      switch (name) {
        case 'content_preview':
          return client.preview(org, repo, path);

        case 'content_publish': {
          const preview = await client.preview(org, repo, path);
          const live = await client.publishLive(org, repo, path);
          return { preview, live };
        }

        case 'content_unpreview':
          return client.unpreview(org, repo, path);

        case 'content_unpublish':
          return client.unpublishLive(org, repo, path);

        default:
          throw new Error(`Unknown EDS tool: ${name}`);
      }
    },
  };
}
