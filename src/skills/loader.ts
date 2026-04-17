import type { DAAdminClient } from '../da-admin/client.js';
import type { DASourceContent } from '../da-admin/types.js';

export interface SkillSummary {
  id: string;
  title: string;
}

export interface SkillsIndex {
  skills: SkillSummary[];
  /** Skills from site config `skills` sheet and/or `/.da/skills/*.md` (same merge as da-nx). */
  source: 'site' | 'none';
}

const SKILLS_SHEET = 'skills';
/** Repo path under the site, matches da-nx `SKILLS_MD_REL`. */
const SKILLS_MD_PATH = '.da/skills';

type SkillRow = {
  key?: string;
  id?: string;
  content?: string;
  value?: string;
  body?: string;
  status?: string;
};

type ListItem = { name: string; path?: string; ext?: string };

function skillRowStatus(row: SkillRow | undefined): 'draft' | 'approved' {
  if (!row) return 'approved';
  const s = String(row.status ?? '')
    .trim()
    .toLowerCase();
  if (s === 'draft') return 'draft';
  return 'approved';
}

function extractTitle(markdown: string): string {
  const lines = markdown.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      const heading = trimmed.match(/^#+\s+(.+)/);
      if (heading) return heading[1];
      return trimmed;
    }
  }
  return '(untitled)';
}

function normalizeSkillId(skillId: string): string {
  return String(skillId || '')
    .trim()
    .replace(/\.md$/i, '');
}

/** Reject path-like ids (matches da-nx `sanitizeSkillFilename` intent). */
function sanitizeSkillFilename(skillId: string): string {
  const t = normalizeSkillId(skillId);
  if (!t || t.includes('/') || t.includes('..') || t.includes('\\')) return '';
  return t;
}

function rowsFromConfig(cfg: Record<string, unknown> | null | undefined): SkillRow[] {
  if (!cfg || typeof cfg !== 'object') return [];
  const sheet = cfg[SKILLS_SHEET] as { data?: SkillRow[] } | undefined;
  return Array.isArray(sheet?.data) ? sheet!.data! : [];
}

function sourceContentString(sc: DASourceContent | string): string {
  if (typeof sc === 'string') return sc;
  return sc?.content ?? '';
}

/**
 * Map approved, non-empty `skills` sheet rows to id → markdown (draft rows excluded).
 */
function skillsKvMapFromRows(rows: SkillRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const id = normalizeSkillId(String(row.key ?? row.id ?? ''));
    if (id && skillRowStatus(row) !== 'draft') {
      const raw = String(row.content ?? row.value ?? row.body ?? '').trim();
      if (raw) {
        out[id] = raw;
      }
    }
  }
  return out;
}

/** Ids that are explicitly marked draft in the sheet (used to block file-only fallbacks for that id). */
function draftSkillIdsFromRows(rows: SkillRow[]): Set<string> {
  const s = new Set<string>();
  for (const row of rows) {
    if (skillRowStatus(row) === 'draft') {
      const id = normalizeSkillId(String(row.key ?? row.id ?? ''));
      if (id) {
        s.add(id);
      }
    }
  }
  return s;
}

/**
 * Load all `/.da/skills/*.md` files (mirrors da-nx `loadSkillsFromMdFiles` merge source).
 */
async function loadSkillsMapFromMdFiles(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<Record<string, string>> {
  try {
    const resp = await client.listSources(org, site, SKILLS_MD_PATH);
    const items = (Array.isArray(resp) ? resp : []) as unknown as ListItem[];
    const mdItems = items.filter((i) => i.ext === 'md' || i.name?.endsWith('.md'));
    const pairs = await Promise.all(
      mdItems.map(async (item) => {
        const id = normalizeSkillId(item.name.replace(/\.md$/i, ''));
        if (!id || !sanitizeSkillFilename(id)) return null;
        const subPath = `${SKILLS_MD_PATH}/${item.name}${
          item.ext && !item.name.endsWith('.md') ? `.${item.ext}` : ''
        }`;
        try {
          const sc = await client.getSource(org, site, subPath);
          const raw = sourceContentString(sc as DASourceContent).trim();
          if (!raw) return null;
          return [id, raw] as const;
        } catch {
          return null;
        }
      }),
    );
    return Object.fromEntries(pairs.filter(Boolean) as [string, string][]);
  } catch {
    return {};
  }
}

/**
 * Merge KV map with repo `.md` map — **file wins** when both define the same id (same as da-nx).
 */
function mergeSkillMaps(
  kvMap: Record<string, string>,
  fileMap: Record<string, string>,
  draftIds: Set<string>,
): Record<string, string> {
  const merged = { ...kvMap, ...fileMap };
  for (const id of draftIds) {
    delete merged[id];
  }
  return merged;
}

/**
 * Load skill index from DA config (`skills` sheet) merged with `/.da/skills/*.md`.
 */
export async function loadSkillsIndex(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<SkillsIndex> {
  try {
    const cfg = await client.getSiteConfig(org, site);
    const rows = rowsFromConfig(cfg);
    const kvMap = skillsKvMapFromRows(rows);
    const draftIds = draftSkillIdsFromRows(rows);
    const fileMap = await loadSkillsMapFromMdFiles(client, org, site);
    const merged = mergeSkillMaps(kvMap, fileMap, draftIds);
    const skills: SkillSummary[] = Object.entries(merged).map(([id, raw]) => ({
      id,
      title: extractTitle(raw),
    }));
    skills.sort((a, b) => a.id.localeCompare(b.id));

    return { skills, source: skills.length > 0 ? 'site' : 'none' };
  } catch {
    return { skills: [], source: 'none' };
  }
}

/**
 * Load full markdown for one skill: `skills` sheet and/or `/.da/skills/{id}.md`.
 * When both exist, **repo file wins** (matches da-nx merge).
 */
export async function loadSkillContent(
  client: DAAdminClient,
  org: string,
  site: string,
  skillId: string,
): Promise<string | null> {
  const want = normalizeSkillId(skillId);
  if (!want) return null;

  try {
    const cfg = await client.getSiteConfig(org, site);
    const rows = rowsFromConfig(cfg);
    const row = rows.find((r) => normalizeSkillId(String(r.key ?? r.id ?? '')) === want);
    if (row && skillRowStatus(row) === 'draft') return null;

    const sheetRaw = row ? String(row.content ?? row.value ?? row.body ?? '').trim() : '';

    let fileRaw: string | null = null;
    const base = sanitizeSkillFilename(want);
    if (base) {
      try {
        const subPath = `${SKILLS_MD_PATH}/${base}.md`;
        const sc = await client.getSource(org, site, subPath);
        const t = sourceContentString(sc as DASourceContent).trim();
        fileRaw = t || null;
      } catch {
        fileRaw = null;
      }
    }

    if (fileRaw) return fileRaw;
    return sheetRaw || null;
  } catch {
    return null;
  }
}

/**
 * Create or update a skill row in the `skills` config sheet.
 */
export async function saveSkillContent(
  client: DAAdminClient,
  org: string,
  site: string,
  skillId: string,
  content: string,
  options?: { status?: 'draft' | 'approved' },
): Promise<{ success: boolean; error?: string }> {
  const id = normalizeSkillId(skillId);
  if (!id) {
    return { success: false, error: 'Missing skill id' };
  }

  try {
    let cfg: Record<string, unknown>;
    try {
      cfg = await client.getSiteConfig(org, site);
    } catch (e: unknown) {
      const err = e as { status?: number };
      if (err?.status === 404) {
        cfg = {};
      } else {
        throw e;
      }
    }

    if (!cfg[SKILLS_SHEET]) {
      cfg[SKILLS_SHEET] = { total: 0, limit: 1000, offset: 0, data: [] };
    }
    const sheet = cfg[SKILLS_SHEET] as {
      total?: number;
      limit?: number;
      offset?: number;
      data: SkillRow[];
    };
    const data = [...(sheet.data || [])];
    const idx = data.findIndex((r) => normalizeSkillId(String(r.key ?? r.id ?? '')) === id);
    const prev = idx >= 0 ? data[idx] : undefined;
    const nextStatus =
      options?.status === 'draft' || options?.status === 'approved'
        ? options.status
        : skillRowStatus(prev);
    const row: SkillRow = { ...(prev || {}), key: id, content, status: nextStatus };
    if (idx >= 0) data[idx] = row;
    else data.push(row);
    cfg[SKILLS_SHEET] = {
      ...sheet,
      data,
      total: data.length,
    };

    await client.saveSiteConfig(org, site, cfg);
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}
