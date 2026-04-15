import type { DAAdminClient } from '../da-admin/client.js';

export interface SkillSummary {
  id: string;
  title: string;
}

export interface SkillsIndex {
  skills: SkillSummary[];
  /** Skills always load from site config KV (`skills` sheet). */
  source: 'site' | 'none';
}

const SKILLS_SHEET = 'skills';

type SkillRow = {
  key?: string;
  id?: string;
  content?: string;
  value?: string;
  body?: string;
  status?: string;
};

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

function rowsFromConfig(cfg: Record<string, unknown> | null | undefined): SkillRow[] {
  if (!cfg || typeof cfg !== 'object') return [];
  const sheet = cfg[SKILLS_SHEET] as { data?: SkillRow[] } | undefined;
  return Array.isArray(sheet?.data) ? sheet!.data! : [];
}

/**
 * Load skill index from DA config KV (`skills` sheet: key + content columns).
 */
export async function loadSkillsIndex(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<SkillsIndex> {
  try {
    const cfg = await client.getSiteConfig(org, site);
    const rows = rowsFromConfig(cfg);
    const skills: SkillSummary[] = rows
      .map((row) => {
        const id = normalizeSkillId(String(row.key ?? row.id ?? ''));
        const raw = String(row.content ?? row.value ?? row.body ?? '');
        if (!id || !raw.trim()) return null;
        if (skillRowStatus(row) === 'draft') return null;
        return { id, title: extractTitle(raw) };
      })
      .filter((s): s is SkillSummary => s !== null);

    return { skills, source: skills.length > 0 ? 'site' : 'none' };
  } catch {
    return { skills: [], source: 'none' };
  }
}

/**
 * Load full markdown for one skill from the `skills` config sheet.
 */
export async function loadSkillContent(
  client: DAAdminClient,
  org: string,
  site: string,
  skillId: string,
): Promise<string | null> {
  const want = normalizeSkillId(skillId);
  try {
    const cfg = await client.getSiteConfig(org, site);
    const rows = rowsFromConfig(cfg);
    const row = rows.find((r) => normalizeSkillId(String(r.key ?? r.id ?? '')) === want);
    if (!row) return null;
    if (skillRowStatus(row) === 'draft') return null;
    const raw = String(row.content ?? row.value ?? row.body ?? '').trim();
    return raw || null;
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
