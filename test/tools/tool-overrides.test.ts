import { describe, it, expect } from 'vitest';
import { loadDisabledTools, applyToolOverrides } from '../../src/tools/tool-overrides.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';

function mockClient(configData?: Record<string, unknown>): DAAdminClient {
  return {
    getSiteConfig: async () => configData ?? {},
  } as unknown as DAAdminClient;
}

describe('loadDisabledTools', () => {
  it('returns empty set when no tool-overrides sheet exists', async () => {
    const client = mockClient({});
    const result = await loadDisabledTools(client, 'org', 'site');
    expect(result.size).toBe(0);
  });

  it('returns empty set when all tools are enabled', async () => {
    const client = mockClient({
      'tool-overrides': {
        data: [
          { key: 'da-tools/content_list', enabled: true },
          { key: 'eds-preview/content_preview', enabled: true },
        ],
      },
    });
    const result = await loadDisabledTools(client, 'org', 'site');
    expect(result.size).toBe(0);
  });

  it('collects disabled built-in DA tools', async () => {
    const client = mockClient({
      'tool-overrides': {
        data: [
          { key: 'da-tools/content_list', enabled: false },
          { key: 'da-tools/content_read', enabled: true },
        ],
      },
    });
    const result = await loadDisabledTools(client, 'org', 'site');
    expect(result).toEqual(new Set(['content_list']));
  });

  it('collects disabled built-in EDS tools', async () => {
    const client = mockClient({
      'tool-overrides': {
        data: [{ key: 'eds-preview/content_preview', enabled: false }],
      },
    });
    const result = await loadDisabledTools(client, 'org', 'site');
    expect(result).toEqual(new Set(['content_preview']));
  });

  it('maps custom MCP tools to mcp__ prefix', async () => {
    const client = mockClient({
      'tool-overrides': {
        data: [{ key: 'ecommerce/get_products', enabled: false }],
      },
    });
    const result = await loadDisabledTools(client, 'org', 'site');
    expect(result).toEqual(new Set(['mcp__ecommerce__get_products']));
  });

  it('handles string "false" as disabled', async () => {
    const client = mockClient({
      'tool-overrides': {
        data: [{ key: 'da-tools/content_delete', enabled: 'false' }],
      },
    });
    const result = await loadDisabledTools(client, 'org', 'site');
    expect(result).toEqual(new Set(['content_delete']));
  });

  it('ignores rows with empty keys', async () => {
    const client = mockClient({
      'tool-overrides': {
        data: [
          { key: '', enabled: false },
          { key: '  ', enabled: false },
        ],
      },
    });
    const result = await loadDisabledTools(client, 'org', 'site');
    expect(result.size).toBe(0);
  });

  it('ignores malformed keys without a slash', async () => {
    const client = mockClient({
      'tool-overrides': {
        data: [{ key: 'content_list', enabled: false }],
      },
    });
    const result = await loadDisabledTools(client, 'org', 'site');
    expect(result.size).toBe(0);
  });

  it('returns empty set on getSiteConfig failure', async () => {
    const client = {
      getSiteConfig: async () => {
        throw new Error('network error');
      },
    } as unknown as DAAdminClient;
    const result = await loadDisabledTools(client, 'org', 'site');
    expect(result.size).toBe(0);
  });
});

describe('applyToolOverrides', () => {
  it('removes disabled tools from the registry', () => {
    const tools: Record<string, unknown> = {
      content_list: { description: 'list' },
      content_read: { description: 'read' },
      content_create: { description: 'create' },
    };
    const disabled = new Set(['content_list', 'content_create']);
    const removed = applyToolOverrides(tools, disabled);

    expect(Object.keys(tools)).toEqual(['content_read']);
    expect(removed).toEqual(expect.arrayContaining(['content_list', 'content_create']));
    expect(removed).toHaveLength(2);
  });

  it('ignores disabled tools not present in registry', () => {
    const tools: Record<string, unknown> = {
      content_list: { description: 'list' },
    };
    const disabled = new Set(['nonexistent_tool']);
    const removed = applyToolOverrides(tools, disabled);

    expect(Object.keys(tools)).toEqual(['content_list']);
    expect(removed).toHaveLength(0);
  });

  it('handles empty disabled set', () => {
    const tools: Record<string, unknown> = {
      content_list: { description: 'list' },
    };
    const removed = applyToolOverrides(tools, new Set());

    expect(Object.keys(tools)).toEqual(['content_list']);
    expect(removed).toHaveLength(0);
  });

  it('removes MCP tools by their prefixed name', () => {
    const tools: Record<string, unknown> = {
      mcp__ecommerce__get_products: { description: 'products' },
      mcp__ecommerce__get_orders: { description: 'orders' },
    };
    const disabled = new Set(['mcp__ecommerce__get_products']);
    const removed = applyToolOverrides(tools, disabled);

    expect(Object.keys(tools)).toEqual(['mcp__ecommerce__get_orders']);
    expect(removed).toEqual(['mcp__ecommerce__get_products']);
  });
});
