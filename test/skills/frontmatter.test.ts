import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  stripFrontmatter,
  parseSkillIndexEntry,
} from '../../src/skills/frontmatter.js';

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses a simple valid block', () => {
    const md = `---
name: brand-voice
description: Enforce brand tone guidelines
version: 3
status: approved
---
# Body`;
    const fields = parseFrontmatter(md);
    expect(fields).toEqual({
      name: 'brand-voice',
      description: 'Enforce brand tone guidelines',
      version: '3',
      status: 'approved',
    });
  });

  it('returns null when no opening delimiter', () => {
    expect(parseFrontmatter('# Just body\nno frontmatter')).toBeNull();
  });

  it('returns null when delimiter is not the first line', () => {
    expect(parseFrontmatter('\n---\nname: x\n---\n')).toBeNull();
  });

  it('lowercases all keys', () => {
    const md = `---\nName: foo\nDESCRIPTION: bar\n---\n`;
    const fields = parseFrontmatter(md);
    expect(fields).toHaveProperty('name', 'foo');
    expect(fields).toHaveProperty('description', 'bar');
  });

  it('unescapes double-quoted values', () => {
    const md = `---\ndescription: "hello \\"world\\""\n---\n`;
    const fields = parseFrontmatter(md);
    expect(fields?.description).toBe('hello "world"');
  });

  it('unescapes single-quoted values with doubled apostrophe', () => {
    const md = `---\ndescription: 'it''s fine'\n---\n`;
    const fields = parseFrontmatter(md);
    expect(fields?.description).toBe("it's fine");
  });

  it('handles bare scalars (no quoting)', () => {
    const md = `---\nname: simple-id\n---\n`;
    const fields = parseFrontmatter(md);
    expect(fields?.name).toBe('simple-id');
  });

  it('returns collected fields for unclosed block', () => {
    const md = `---\nname: partial\ndescription: no closer`;
    const fields = parseFrontmatter(md);
    expect(fields).not.toBeNull();
    expect(fields?.name).toBe('partial');
  });

  it('skips lines without a colon', () => {
    const md = `---\nname: ok\njunk line\n---\n`;
    const fields = parseFrontmatter(md);
    expect(fields).toEqual({ name: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// stripFrontmatter
// ---------------------------------------------------------------------------

describe('stripFrontmatter', () => {
  it('strips the frontmatter block and returns the body', () => {
    const md = `---
name: x
---
# Heading

Body text.`;
    expect(stripFrontmatter(md)).toBe('# Heading\n\nBody text.');
  });

  it('returns original string when no frontmatter', () => {
    const md = '# Title\n\nBody.';
    expect(stripFrontmatter(md)).toBe(md);
  });

  it('strips only the opener for an unclosed block', () => {
    const md = `---\nname: x\nnever closed`;
    const stripped = stripFrontmatter(md);
    expect(stripped).toContain('name: x');
    expect(stripped).not.toMatch(/^---/);
  });

  it('trims leading newlines after the closing delimiter', () => {
    const md = `---\nname: x\n---\n\n\n# Body`;
    expect(stripFrontmatter(md)).toBe('# Body');
  });
});

// ---------------------------------------------------------------------------
// parseSkillIndexEntry
// ---------------------------------------------------------------------------

describe('parseSkillIndexEntry', () => {
  it('returns correct fields for a valid skill', () => {
    const md = `---
name: seo-checklist
description: Run SEO checks before publish
version: 5
status: approved
---
# SEO`;
    const entry = parseSkillIndexEntry(md);
    expect(entry).toEqual({
      name: 'seo-checklist',
      description: 'Run SEO checks before publish',
      version: 5,
      status: 'approved',
    });
  });

  it('defaults status to approved when absent', () => {
    const md = `---\nname: x\ndescription: y\nversion: 1\n---\n`;
    expect(parseSkillIndexEntry(md).status).toBe('approved');
  });

  it('defaults status to approved for unrecognised values', () => {
    const md = `---\nname: x\ndescription: y\nversion: 1\nstatus: pending\n---\n`;
    expect(parseSkillIndexEntry(md).status).toBe('approved');
  });

  it('recognises draft status', () => {
    const md = `---\nname: x\ndescription: y\nversion: 1\nstatus: draft\n---\n`;
    expect(parseSkillIndexEntry(md).status).toBe('draft');
  });

  it('returns version 0 for a non-numeric version', () => {
    const md = `---\nname: x\ndescription: y\nversion: abc\n---\n`;
    expect(parseSkillIndexEntry(md).version).toBe(0);
  });

  it('returns version 0 when version is absent', () => {
    const md = `---\nname: x\ndescription: y\n---\n`;
    expect(parseSkillIndexEntry(md).version).toBe(0);
  });

  it('returns empty strings when frontmatter is absent', () => {
    const entry = parseSkillIndexEntry('# No frontmatter');
    expect(entry.name).toBe('');
    expect(entry.description).toBe('');
    expect(entry.version).toBe(0);
  });

  it('does not throw on empty string', () => {
    expect(() => parseSkillIndexEntry('')).not.toThrow();
  });

  it('parses execution_* fields into a structured execution object', () => {
    const md = `---
name: convert-tables
description: Convert HTML tables
version: 1
status: approved
execution_entry: convert
execution_runtimes: js
execution_capabilities:
execution_timeout_ms: 5000
---
# Convert Tables`;
    const entry = parseSkillIndexEntry(md);
    expect(entry.execution).toEqual({
      entry: 'convert',
      runtimes: ['js'],
      capabilities: [],
      timeoutMs: 5000,
      dependencies: [],
    });
  });

  it('parses execution_dependencies into a string array', () => {
    const md = `---
name: compress-skill
description: Compress output
version: 1
execution_entry: compress
execution_runtimes: js
execution_dependencies: fflate
---`;
    const entry = parseSkillIndexEntry(md);
    expect(entry.execution?.dependencies).toEqual(['fflate']);
  });

  it('parses multiple execution_dependencies', () => {
    const md = `---
name: multi-dep
description: Multiple deps
version: 1
execution_entry: run
execution_runtimes: js
execution_dependencies: fflate, lodash, uuid
---`;
    const entry = parseSkillIndexEntry(md);
    expect(entry.execution?.dependencies).toEqual(['fflate', 'lodash', 'uuid']);
  });

  it('sets dependencies to empty array when execution_dependencies is absent', () => {
    const md = `---
name: no-deps
description: No deps
version: 1
execution_entry: run
execution_runtimes: js
---`;
    const entry = parseSkillIndexEntry(md);
    expect(entry.execution?.dependencies).toEqual([]);
  });

  it('yields execution: undefined when execution_entry is absent (backwards-compat)', () => {
    const md = `---\nname: prose-skill\ndescription: A prose skill\nversion: 1\n---\n# Body`;
    const entry = parseSkillIndexEntry(md);
    expect(entry.execution).toBeUndefined();
  });

  it('parses multiple runtimes and capabilities', () => {
    const md = `---
name: multi-runtime
description: Multi-runtime skill
version: 1
execution_entry: run
execution_runtimes: js, wasm
execution_capabilities: dom, fetch
execution_timeout_ms: 10000
---`;
    const entry = parseSkillIndexEntry(md);
    expect(entry.execution?.runtimes).toEqual(['js', 'wasm']);
    expect(entry.execution?.capabilities).toEqual(['dom', 'fetch']);
    expect(entry.execution?.dependencies).toEqual([]);
  });

  it('defaults timeout to 5000 when execution_timeout_ms is absent', () => {
    const md = `---\nname: x\ndescription: y\nversion: 1\nexecution_entry: run\nexecution_runtimes: js\n---\n`;
    const entry = parseSkillIndexEntry(md);
    expect(entry.execution?.timeoutMs).toBe(5000);
  });

  it('defaults timeout to 5000 when execution_timeout_ms is non-numeric', () => {
    const md = `---\nname: x\ndescription: y\nversion: 1\nexecution_entry: run\nexecution_timeout_ms: bad\n---\n`;
    const entry = parseSkillIndexEntry(md);
    expect(entry.execution?.timeoutMs).toBe(5000);
  });
});
