import type { DAAdminClient } from '../da-admin/client.js';

const MEMORY_PATH = '.da/agent/memory.md';
const RECENT_PAGES_PATH = '.da/agent/recent-pages.json';
const MAX_RECENT_PAGES = 10;

export interface RecentPage {
  path: string;
  date: string;
  summary: string;
}

function extractContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null && 'content' in raw) {
    return String((raw as { content?: unknown }).content ?? '');
  }
  return '';
}

export async function fetchProjectMemory(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<string | null> {
  try {
    const raw = await client.getSource(org, site, MEMORY_PATH);
    const body = extractContent(raw);
    return body || null;
  } catch {
    return null;
  }
}

export async function saveProjectMemory(
  client: DAAdminClient,
  org: string,
  site: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await client.createSource(org, site, MEMORY_PATH, content, 'text/markdown');
    return { success: true };
  } catch (e: unknown) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function updateRecentPages(
  client: DAAdminClient,
  org: string,
  site: string,
  entry: { path: string; summary: string; date?: string },
): Promise<{ success: boolean; error?: string }> {
  let pages: RecentPage[] = [];
  try {
    const raw = await client.getSource(org, site, RECENT_PAGES_PATH);
    if (Array.isArray(raw)) {
      // DA client already parsed the JSON response (application/json content-type)
      pages = raw as RecentPage[];
    } else {
      const body = extractContent(raw);
      if (body) {
        try {
          pages = JSON.parse(body) as RecentPage[];
        } catch {
          // corrupt JSON — start fresh
        }
      }
    }
  } catch {
    // no existing file — start fresh
  }

  const newEntry: RecentPage = {
    path: entry.path,
    date: entry.date ?? new Date().toISOString(),
    summary: entry.summary,
  };

  pages = pages.filter((p) => p.path !== entry.path);
  pages.unshift(newEntry);
  if (pages.length > MAX_RECENT_PAGES) pages = pages.slice(0, MAX_RECENT_PAGES);

  try {
    await client.createSource(
      org,
      site,
      RECENT_PAGES_PATH,
      JSON.stringify(pages, null, 2),
      'application/json',
    );
    return { success: true };
  } catch (e: unknown) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
