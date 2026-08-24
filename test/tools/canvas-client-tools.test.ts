import { describe, it, expect } from 'vitest';
import { CANVAS_CLIENT_ONLY_TOOLS, createCanvasClientTools } from '../../src/tools/tools.js';

describe('CANVAS_CLIENT_ONLY_TOOLS', () => {
  it('includes skill_run_script', () => {
    expect(CANVAS_CLIENT_ONLY_TOOLS).toContain('skill_run_script');
  });
});

describe('createCanvasClientTools — skill_run_script', () => {
  it('is present in the returned tools object', () => {
    const tools = createCanvasClientTools();
    expect(tools).toHaveProperty('skill_run_script');
  });

  it('has no execute function (client-executed only)', () => {
    const tools = createCanvasClientTools();
    // Vercel AI SDK client-only tools must NOT have an execute property.
    expect((tools.skill_run_script as Record<string, unknown>).execute).toBeUndefined();
  });

  it('has an inputSchema with skillId and input fields', () => {
    const tools = createCanvasClientTools();
    const tool = tools.skill_run_script as Record<string, unknown>;
    // Verify via JSON Schema shape (toJSONSchema is Zod v4 API)
    const schema = tool.inputSchema as { toJSONSchema: () => Record<string, unknown> };
    const json = schema.toJSONSchema() as { properties?: Record<string, unknown> };
    expect(json.properties).toHaveProperty('skillId');
    expect(json.properties).toHaveProperty('input');
  });

  it('rejects input missing skillId', () => {
    const tools = createCanvasClientTools();
    const tool = tools.skill_run_script as Record<string, unknown>;
    const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ input: {} }).success).toBe(false);
  });

  it('rejects input with empty skillId', () => {
    const tools = createCanvasClientTools();
    const tool = tools.skill_run_script as Record<string, unknown>;
    const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ skillId: '', input: {} }).success).toBe(false);
  });

  it('has an outputSchema with optional output and error fields', () => {
    const tools = createCanvasClientTools();
    const tool = tools.skill_run_script as Record<string, unknown>;
    const schema = tool.outputSchema as { toJSONSchema: () => Record<string, unknown> };
    const json = schema.toJSONSchema() as { properties?: Record<string, unknown> };
    expect(json.properties).toHaveProperty('output');
    expect(json.properties).toHaveProperty('error');
  });
});
