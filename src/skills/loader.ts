import type { DAAdminClient } from '../da-admin/client.js';
import type { DASource } from '../da-admin/types.js';

export interface SkillSummary {
  id: string;
  title: string;
}

export interface SkillsIndex {
  skills: SkillSummary[];
  source: 'site' | 'none';
}

const SKILLS_SHEET = 'skills';
const SKILLS_DIR = '.da/skills';

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
 * List .md files in .da/skills/ and read their contents.
 * Returns a map of { skillId → markdown }.
 */
async function loadSkillFiles(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    console.log(`[skills] listing ${SKILLS_DIR} for ${org}/${site}`);
    const items: DASource[] = await client.listSources(org, site, SKILLS_DIR);
    const mdItems = (Array.isArray(items) ? items : []).filter((item) => {
      const ext = String(item.ext ?? '').toLowerCase();
      const name = String(item.name ?? '');
      return ext === 'md' || name.toLowerCase().endsWith('.md');
    });
    console.log(`[skills] found ${mdItems.length} .md file(s) in ${SKILLS_DIR}`);
    await Promise.all(
      mdItems.map(async (item) => {
        const filename = item.path?.split('/').pop() ?? item.name;
        const id = normalizeSkillId(filename);
        if (!id) return;
        try {
          const src = await client.getSource(org, site, `${SKILLS_DIR}/${filename}`);
          const text = typeof src === 'string' ? src : ((src as any)?.content ?? '');
          if (text) out.set(id, text);
        } catch {
          /* skip unreadable files */
        }
      }),
    );
  } catch (e) {
    console.log(`[skills] loadSkillFiles error for ${org}/${site}:`, e);
  }
  return out;
}

/**
 * Load skill index by merging config `skills` sheet with .da/skills/*.md files.
 * Config rows take precedence for status; .md file body is used when present.
 * Skills that exist only as .md files (no config row) are treated as approved.
 */
export async function loadSkillsIndex(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<SkillsIndex> {
  try {
    const [cfg, fileMap] = await Promise.all([
      client.getSiteConfig(org, site).catch(() => null),
      loadSkillFiles(client, org, site),
    ]);

    const rows = rowsFromConfig(cfg);
    const seen = new Set<string>();
    const skills: SkillSummary[] = [];

    // Config rows first (they carry status)
    for (const row of rows) {
      const id = normalizeSkillId(String(row.key ?? row.id ?? ''));
      const body = fileMap.get(id) ?? String(row.content ?? row.value ?? row.body ?? '');
      if (id && body.trim() && skillRowStatus(row) !== 'draft') {
        seen.add(id);
        skills.push({ id, title: extractTitle(body) });
      }
    }

    // .md-only files (no config row) — treat as approved
    for (const [id, body] of fileMap) {
      if (!seen.has(id)) {
        skills.push({ id, title: extractTitle(body) });
      }
    }

    return { skills, source: skills.length > 0 ? 'site' : 'none' };
  } catch {
    return { skills: [], source: 'none' };
  }
}

/**
 * Load full markdown for one skill.
 * Checks .da/skills/{id}.md first, falls back to config sheet.
 */
export async function loadSkillContent(
  client: DAAdminClient,
  org: string,
  site: string,
  skillId: string,
): Promise<string | null> {
  const want = normalizeSkillId(skillId);

  // Try .md file first — it's the canonical body when both exist
  try {
    const src = await client.getSource(org, site, `${SKILLS_DIR}/${want}.md`);
    const text = typeof src === 'string' ? src : ((src as any)?.content ?? '');
    if (text.trim()) return text.trim();
  } catch {
    /* file may not exist — fall through to config */
  }

  // Fall back to config sheet
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
