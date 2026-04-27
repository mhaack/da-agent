import type { DAAdminClient } from '../da-admin/client.js';

const TOOL_OVERRIDES_SHEET = 'tool-overrides';

const BUILT_IN_SERVERS = new Set(['da-tools', 'eds-preview']);

/**
 * Map a UI override key ("serverId/toolName") to the corresponding
 * tool key used in the agent's allTools registry.
 *
 * Built-in servers (da-tools, eds-preview) register tools under their
 * plain name (e.g. "content_list"), while MCP servers use the
 * "mcp__<serverId>__<toolName>" convention.
 */
function overrideKeyToToolName(key: string): string | null {
  const slash = key.indexOf('/');
  if (slash < 0) return null;
  const serverId = key.slice(0, slash);
  const toolName = key.slice(slash + 1);
  if (!serverId || !toolName) return null;
  if (BUILT_IN_SERVERS.has(serverId)) return toolName;
  return `mcp__${serverId}__${toolName}`;
}

/**
 * Load the set of tool names that have been explicitly disabled
 * via the site's `tool-overrides` config sheet.
 */
export async function loadDisabledTools(
  client: DAAdminClient,
  org: string,
  site: string,
): Promise<Set<string>> {
  const disabled = new Set<string>();
  try {
    const config = await client.getSiteConfig(org, site);
    const sheet = (config as Record<string, { data?: Record<string, unknown>[] }>)?.[
      TOOL_OVERRIDES_SHEET
    ];
    const rows = sheet?.data;
    if (!Array.isArray(rows)) return disabled;

    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const key = String(r?.key ?? '').trim();
      if (key) {
        const val = r?.enabled;
        const isDisabled = val === false || val === 'false';
        if (isDisabled) {
          const toolName = overrideKeyToToolName(key);
          if (toolName) disabled.add(toolName);
        }
      }
    }
  } catch {
    // Non-fatal — if we can't load overrides, all tools remain available
  }
  return disabled;
}

/**
 * Remove disabled tools from a tools registry (mutates in place).
 * Returns the set of tool names that were removed.
 */
export function applyToolOverrides(
  tools: Record<string, unknown>,
  disabled: Set<string>,
): string[] {
  const removed: string[] = [];
  for (const name of disabled) {
    if (name in tools) {
      delete tools[name];
      removed.push(name);
    }
  }
  return removed;
}
