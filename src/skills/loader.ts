import type { DAAdminClient } from '../da-admin/client.js';

export interface SkillSummary {
  id: string;
  title: string;
}

export interface SkillsIndex {
  skills: SkillSummary[];
  source: 'site' | 'org' | 'none';
}

interface ListItem {
  name: string;
  path: string;
  ext?: string;
  lastModified?: number;
}

const SKILLS_PATH = '.da/skills';

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

/**
 * List skill files from /.da/skills/ via the admin API.
 * The list endpoint returns a flat array of { name, path, ext?, lastModified? }.
 * DAAdminClient.listSources types this as DAListSourcesResponse, but at runtime
 * the actual shape is a plain array, so we cast accordingly.
 */
async function listSkillFiles(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<{ items: ListItem[]; source: 'site' | 'org' }> {
  try {
    const resp = await client.listSources(org, site, SKILLS_PATH);
    const items = (Array.isArray(resp) ? resp : []) as unknown as ListItem[];
    const mdItems = items.filter((i) => i.ext === 'md' || i.name?.endsWith('.md'));
    if (mdItems.length > 0) return { items: mdItems, source: 'site' };
  } catch {
    // Site-level not found, try org-level fallback
  }

  try {
    // Org-level: /{org}/.da/skills → listSources(org, '.da', 'skills')
    const resp = await client.listSources(org, '.da', 'skills');
    const items = (Array.isArray(resp) ? resp : []) as unknown as ListItem[];
    const mdItems = items.filter((i) => i.ext === 'md' || i.name?.endsWith('.md'));
    if (mdItems.length > 0) return { items: mdItems, source: 'org' };
  } catch {
    // Org-level also unavailable
  }

  return { items: [], source: 'site' };
}

/**
 * Load a skill summary index: ids and first headings.
 * Tries site-level first, falls back to org-level.
 */
export async function loadSkillsIndex(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<SkillsIndex> {
  const { items, source } = await listSkillFiles(client, org, site);

  if (items.length === 0) {
    return { skills: [], source: 'none' };
  }

  const skills: SkillSummary[] = await Promise.all(
    items.map(async (item) => {
      const id = item.name.replace(/\.md$/, '');
      try {
        const pathSegment = `${SKILLS_PATH}/${item.name}${item.ext && !item.name.endsWith('.md') ? `.${item.ext}` : ''}`;
        const target = source === 'org' ? '.da' : site;
        const subPath =
          source === 'org'
            ? `skills/${item.name}${item.ext && !item.name.endsWith('.md') ? `.${item.ext}` : ''}`
            : pathSegment;

        const content = await client.getSource(org, target, subPath);
        const body =
          typeof content === 'string'
            ? content
            : ((content as unknown as { content?: string })?.content ?? '');
        return { id, title: extractTitle(body) };
      } catch {
        return { id, title: id };
      }
    }),
  );

  return { skills, source };
}

/**
 * Load the full markdown content of a single skill by id.
 * Tries site-level first, falls back to org-level.
 */
export async function loadSkillContent(
  client: DAAdminClient,
  org: string,
  site: string,
  skillId: string,
): Promise<string | null> {
  const filename = skillId.endsWith('.md') ? skillId : `${skillId}.md`;

  // Site-level
  try {
    const content = await client.getSource(org, site, `${SKILLS_PATH}/${filename}`);
    const body =
      typeof content === 'string'
        ? content
        : ((content as unknown as { content?: string })?.content ?? '');
    if (body) return body;
  } catch {
    // fall through to org-level
  }

  // Org-level
  try {
    const content = await client.getSource(org, '.da', `skills/${filename}`);
    const body =
      typeof content === 'string'
        ? content
        : ((content as unknown as { content?: string })?.content ?? '');
    if (body) return body;
  } catch {
    // not found
  }

  return null;
}

/**
 * Save a skill (create or update) as a markdown file under /.da/skills/.
 */
export async function saveSkillContent(
  client: DAAdminClient,
  org: string,
  site: string,
  skillId: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  const filename = skillId.endsWith('.md') ? skillId : `${skillId}.md`;
  try {
    await client.createSource(org, site, `${SKILLS_PATH}/${filename}`, content, 'text/markdown');
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}
