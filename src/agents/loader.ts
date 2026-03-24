import type { DAAdminClient } from '../da-admin/client.js';

export interface AgentPreset {
  name: string;
  description: string;
  systemPrompt: string;
  skills: string[];
  mcpServers: string[];
  icon?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  icon?: string;
}

interface ListItem {
  name: string;
  path: string;
  ext?: string;
}

const AGENTS_PATH = '.da/agents';

function parsePreset(raw: string): AgentPreset | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.name || typeof parsed.name !== 'string') return null;
    return {
      name: parsed.name,
      description: parsed.description ?? '',
      systemPrompt: parsed.systemPrompt ?? '',
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
      icon: parsed.icon,
    };
  } catch {
    return null;
  }
}

async function listAgentFiles(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<{ items: ListItem[]; source: 'site' | 'org' }> {
  try {
    const resp = await client.listSources(org, site, AGENTS_PATH);
    const items = (Array.isArray(resp) ? resp : []) as unknown as ListItem[];
    const jsonItems = items.filter((i) => i.ext === 'json' || i.name?.endsWith('.json'));
    if (jsonItems.length > 0) return { items: jsonItems, source: 'site' };
  } catch {
    // fall through
  }

  try {
    const resp = await client.listSources(org, '.da', 'agents');
    const items = (Array.isArray(resp) ? resp : []) as unknown as ListItem[];
    const jsonItems = items.filter((i) => i.ext === 'json' || i.name?.endsWith('.json'));
    if (jsonItems.length > 0) return { items: jsonItems, source: 'org' };
  } catch {
    // org-level also unavailable
  }

  return { items: [], source: 'site' };
}

export async function listAgentPresets(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<AgentSummary[]> {
  const { items, source } = await listAgentFiles(client, org, site);

  const summaries: AgentSummary[] = await Promise.all(
    items.map(async (item) => {
      const id = item.name.replace(/\.json$/, '');
      try {
        const target = source === 'org' ? '.da' : site;
        const subPath = source === 'org'
          ? `agents/${item.name}${item.ext && !item.name.endsWith('.json') ? `.${item.ext}` : ''}`
          : `${AGENTS_PATH}/${item.name}${item.ext && !item.name.endsWith('.json') ? `.${item.ext}` : ''}`;
        const content = await client.getSource(org, target, subPath);
        const raw = typeof content === 'string' ? content : (content as any)?.content ?? '';
        const preset = parsePreset(raw);
        return {
          id,
          name: preset?.name ?? id,
          description: preset?.description ?? '',
          icon: preset?.icon,
        };
      } catch {
        return { id, name: id, description: '' };
      }
    }),
  );

  return summaries;
}

export async function loadAgentPreset(
  client: DAAdminClient,
  org: string,
  site: string,
  agentId: string,
): Promise<AgentPreset | null> {
  const filename = agentId.endsWith('.json') ? agentId : `${agentId}.json`;

  // Site-level
  try {
    const content = await client.getSource(org, site, `${AGENTS_PATH}/${filename}`);
    const raw = typeof content === 'string' ? content : (content as any)?.content ?? '';
    if (raw) return parsePreset(raw);
  } catch {
    // fall through
  }

  // Org-level
  try {
    const content = await client.getSource(org, '.da', `agents/${filename}`);
    const raw = typeof content === 'string' ? content : (content as any)?.content ?? '';
    if (raw) return parsePreset(raw);
  } catch {
    // not found
  }

  return null;
}

export async function saveAgentPreset(
  client: DAAdminClient,
  org: string,
  site: string,
  agentId: string,
  preset: AgentPreset,
): Promise<{ success: boolean; error?: string }> {
  const filename = agentId.endsWith('.json') ? agentId : `${agentId}.json`;
  try {
    const json = JSON.stringify(preset, null, 2);
    await client.createSource(org, site, `${AGENTS_PATH}/${filename}`, json, 'application/json');
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
}
