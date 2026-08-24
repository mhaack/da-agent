/**
 * Minimal YAML frontmatter reader for skill files.
 *
 * Only covers the read-side (parse + strip + index). The write-side
 * (validation, escaping, bumping) lives in ew-extensions and is not needed
 * by the agent, which is strictly a consumer of skill files.
 *
 * Compatible with the frontmatter contract defined in
 * `private-docs/skills-storage-redesign-plan.md § B`.
 *
 * ```yaml
 * ---
 * name: my-skill        # required, folder name wins on conflict
 * description: ...      # required, ≤1024 chars
 * version: 1            # required, positive integer
 * status: approved      # optional (default approved); draft skipped by agent
 * ---
 * ```
 */

const FM_DELIMITER_RE = /^---[ \t]*$/;

/**
 * Inline YAML scalar unescaper — handles single-quoted and double-quoted
 * strings the same way the writer in `skill-frontmatter.js` escapes them.
 * Falls back to the raw value for bare scalars.
 */
function unescapeScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Parse a YAML frontmatter block. Returns a map of lowercased keys to
 * unescaped string values, or `null` when no valid block is present.
 *
 * Supports only simple `key: value` lines. Multi-line values, block
 * scalars, and nested mappings are not supported — the frontmatter
 * contract forbids them.
 */
export function parseFrontmatter(markdown: string): Record<string, string> | null {
  const lines = markdown.split('\n');
  if (!FM_DELIMITER_RE.test(lines[0].trimEnd())) return null;

  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (FM_DELIMITER_RE.test(line.trimEnd())) return fields;
    const colon = line.indexOf(':');
    if (colon >= 1) {
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = unescapeScalar(line.slice(colon + 1));
      if (key) fields[key] = value;
    }
  }
  // Unclosed block — return whatever we collected
  return fields;
}

/**
 * Remove the frontmatter block from a markdown string.
 * If the block is unclosed (no closing `---`), strips just the opener line.
 */
export function stripFrontmatter(markdown: string): string {
  const lines = markdown.split('\n');
  if (!FM_DELIMITER_RE.test(lines[0].trimEnd())) return markdown;

  for (let i = 1; i < lines.length; i += 1) {
    if (FM_DELIMITER_RE.test(lines[i].trimEnd())) {
      return lines
        .slice(i + 1)
        .join('\n')
        .replace(/^\n+/, '');
    }
  }
  // Unclosed — drop only the opener line
  return lines.slice(1).join('\n');
}

/** Execution metadata parsed from flat `execution_*` frontmatter fields. */
export interface SkillExecutionMeta {
  /** The script entry-point identifier (e.g. `"convert"`). */
  entry: string;
  /** Supported runtime identifiers (e.g. `["js"]`). */
  runtimes: string[];
  /**
   * Required client capabilities. Empty array means the skill is
   * client-eligible with no extra capability requirements.
   */
  capabilities: string[];
  /** Execution timeout in milliseconds. */
  timeoutMs: number;
  /**
   * npm package names the script requires (e.g. `["fflate"]`).
   * Parsed from `execution_dependencies` (comma-separated).
   * Empty array when the field is absent or empty.
   * The agent carries this value as-is; dependency decisions are made by
   * the client, not the agent.
   */
  dependencies: string[];
}

export interface SkillIndexEntry {
  /** Frontmatter `name` value, or empty string when absent. */
  name: string;
  /** Frontmatter `description` value, or empty string when absent. */
  description: string;
  /** Frontmatter `version` as a positive integer, or 0 when unparseable. */
  version: number;
  /** Defaults to `'approved'` when the field is absent or unrecognised. */
  status: 'approved' | 'draft';
  /**
   * Present only when the skill carries execution metadata
   * (`execution_entry` frontmatter field). Absent for prose-only skills.
   */
  execution?: SkillExecutionMeta;
}

/** Parse a comma-separated list field into a trimmed, non-empty string array. */
function parseCommaSeparated(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract just the manifest-relevant fields from a skill.md file.
 * Never throws; missing or malformed fields fall back to safe defaults.
 */
export function parseSkillIndexEntry(markdown: string): SkillIndexEntry {
  const fields = parseFrontmatter(markdown) ?? {};
  const rawVersion = parseInt(fields.version ?? '', 10);
  const version = Number.isFinite(rawVersion) && rawVersion > 0 ? rawVersion : 0;
  const status = (fields.status ?? '').trim().toLowerCase() === 'draft' ? 'draft' : 'approved';

  const entry: SkillIndexEntry = {
    name: (fields.name ?? '').trim(),
    description: (fields.description ?? '').trim(),
    version,
    status,
  };

  const executionEntry = (fields.execution_entry ?? '').trim();
  if (executionEntry) {
    const rawTimeout = parseInt(fields.execution_timeout_ms ?? '', 10);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 5000;
    entry.execution = {
      entry: executionEntry,
      runtimes: parseCommaSeparated(fields.execution_runtimes),
      capabilities: parseCommaSeparated(fields.execution_capabilities),
      timeoutMs,
      dependencies: parseCommaSeparated(fields.execution_dependencies),
    };
  }

  return entry;
}
