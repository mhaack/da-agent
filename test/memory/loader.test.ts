import { describe, it, expect } from 'vitest';
import {
  fetchProjectMemory,
  saveProjectMemory,
  updateRecentPages,
} from '../../src/memory/loader.js';
import type { DAAdminClient } from '../../src/da-admin/client.js';

function mockClient(opts: {
  sources?: Record<string, string>;
  createResult?: unknown;
  createError?: string;
}): DAAdminClient {
  return {
    getSource: async (_org: string, repo: string, path: string) => {
      const key = `${repo}/${path}`;
      const raw = opts.sources?.[key];
      if (raw === undefined) throw new Error(`Not found: ${key}`);
      return raw as any;
    },
    createSource: async (_org: string, _repo: string, _path: string, _content: string) => {
      if (opts.createError) throw new Error(opts.createError);
      return opts.createResult ?? { success: true };
    },
  } as unknown as DAAdminClient;
}

// ---------------------------------------------------------------------------
// fetchProjectMemory
// ---------------------------------------------------------------------------

describe('fetchProjectMemory', () => {
  it('returns memory content when file exists', async () => {
    const client = mockClient({
      sources: { 'mysite/.da/agent/memory.md': '# Site Memory\n\nAbout this site.' },
    });
    const result = await fetchProjectMemory(client, 'org', 'mysite');
    expect(result).toBe('# Site Memory\n\nAbout this site.');
  });

  it('returns null when file does not exist', async () => {
    const client = mockClient({});
    const result = await fetchProjectMemory(client, 'org', 'mysite');
    expect(result).toBeNull();
  });

  it('returns null when content is empty string', async () => {
    const client = mockClient({ sources: { 'mysite/.da/agent/memory.md': '' } });
    const result = await fetchProjectMemory(client, 'org', 'mysite');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// saveProjectMemory
// ---------------------------------------------------------------------------

describe('saveProjectMemory', () => {
  it('saves memory content and returns success', async () => {
    const client = mockClient({});
    const result = await saveProjectMemory(client, 'org', 'mysite', '# New Memory');
    expect(result.success).toBe(true);
  });

  it('returns error when save fails', async () => {
    const client = mockClient({ createError: 'Permission denied' });
    const result = await saveProjectMemory(client, 'org', 'mysite', '# Memory');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
  });
});

// ---------------------------------------------------------------------------
// updateRecentPages
// ---------------------------------------------------------------------------

describe('updateRecentPages', () => {
  it('creates a new list with first entry when no file exists', async () => {
    let saved: string | undefined;
    const client = {
      getSource: async () => {
        throw new Error('Not found');
      },
      createSource: async (_o: string, _r: string, _p: string, content: string) => {
        saved = content;
        return { success: true };
      },
    } as unknown as DAAdminClient;

    await updateRecentPages(client, 'org', 'mysite', {
      path: '/en/index.html',
      summary: 'Updated hero',
    });

    const pages = JSON.parse(saved!);
    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe('/en/index.html');
    expect(pages[0].summary).toBe('Updated hero');
    expect(pages[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('prepends new entry to existing list (string JSON)', async () => {
    const existing = JSON.stringify([
      { path: '/en/about.html', date: '2026-01-01T00:00:00.000Z', summary: 'Old entry' },
    ]);
    let saved: string | undefined;
    const client = {
      getSource: async () => existing,
      createSource: async (_o: string, _r: string, _p: string, content: string) => {
        saved = content;
        return { success: true };
      },
    } as unknown as DAAdminClient;

    await updateRecentPages(client, 'org', 'mysite', {
      path: '/en/index.html',
      summary: 'Updated hero',
    });

    const pages = JSON.parse(saved!);
    expect(pages).toHaveLength(2);
    expect(pages[0].path).toBe('/en/index.html');
    expect(pages[1].path).toBe('/en/about.html');
  });

  it('prepends new entry to existing list (pre-parsed array from DA client)', async () => {
    const existing = [
      { path: '/en/about.html', date: '2026-01-01T00:00:00.000Z', summary: 'Old entry' },
    ];
    let saved: string | undefined;
    const client = {
      getSource: async () => existing,
      createSource: async (_o: string, _r: string, _p: string, content: string) => {
        saved = content;
        return { success: true };
      },
    } as unknown as DAAdminClient;

    await updateRecentPages(client, 'org', 'mysite', {
      path: '/en/index.html',
      summary: 'Updated hero',
    });

    const pages = JSON.parse(saved!);
    expect(pages).toHaveLength(2);
    expect(pages[0].path).toBe('/en/index.html');
    expect(pages[1].path).toBe('/en/about.html');
  });

  it('deduplicates: existing entry for same path moves to front with new summary', async () => {
    const existing = JSON.stringify([
      { path: '/en/index.html', date: '2026-01-01T00:00:00.000Z', summary: 'First edit' },
      { path: '/en/about.html', date: '2026-01-01T00:00:00.000Z', summary: 'Old entry' },
    ]);
    let saved: string | undefined;
    const client = {
      getSource: async () => existing,
      createSource: async (_o: string, _r: string, _p: string, content: string) => {
        saved = content;
        return { success: true };
      },
    } as unknown as DAAdminClient;

    await updateRecentPages(client, 'org', 'mysite', {
      path: '/en/index.html',
      summary: 'Second edit',
    });

    const pages = JSON.parse(saved!);
    expect(pages).toHaveLength(2);
    expect(pages[0].path).toBe('/en/index.html');
    expect(pages[0].summary).toBe('Second edit');
    expect(pages[1].path).toBe('/en/about.html');
  });

  it('trims list to max 10 entries, dropping oldest', async () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({
      path: `/en/page-${i}.html`,
      date: '2026-01-01T00:00:00.000Z',
      summary: `Page ${i}`,
    }));
    let saved: string | undefined;
    const client = {
      getSource: async () => JSON.stringify(existing),
      createSource: async (_o: string, _r: string, _p: string, content: string) => {
        saved = content;
        return { success: true };
      },
    } as unknown as DAAdminClient;

    await updateRecentPages(client, 'org', 'mysite', {
      path: '/en/new.html',
      summary: 'Brand new',
    });

    const pages = JSON.parse(saved!);
    expect(pages).toHaveLength(10);
    expect(pages[0].path).toBe('/en/new.html');
    expect(pages.find((p: any) => p.path === '/en/page-9.html')).toBeUndefined();
  });

  it('returns error when write fails', async () => {
    const client = {
      getSource: async () => {
        throw new Error('Not found');
      },
      createSource: async () => {
        throw new Error('Write failed');
      },
    } as unknown as DAAdminClient;

    const result = await updateRecentPages(client, 'org', 'mysite', {
      path: '/en/index.html',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Write failed');
  });

  it('starts fresh when existing JSON is corrupt', async () => {
    let saved: string | undefined;
    const client = {
      getSource: async () => 'not-valid-json{{{',
      createSource: async (_o: string, _r: string, _p: string, content: string) => {
        saved = content;
        return { success: true };
      },
    } as unknown as DAAdminClient;

    await updateRecentPages(client, 'org', 'mysite', {
      org: 'org',
      site: 'mysite',
      path: '/en/index.html',
      summary: 'Test',
    });

    const pages = JSON.parse(saved!);
    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe('/en/index.html');
  });
});
