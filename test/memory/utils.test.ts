import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  estimateTokens,
  extractLastUserMessageText,
  collectAssistantTextFromSteps,
  hasProjectMemoryToolCall,
  shouldPersistMemoryFallback,
  summarizeForMemory,
  mergeMemoryWithFallback,
  AUTO_MEMORY_HEADER,
} from '../../src/memory/utils.js';

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up fractional tokens', () => {
    // 7 chars / 3.5 = exactly 2
    expect(estimateTokens('1234567')).toBe(2);
    // 8 chars / 3.5 = 2.28 → ceil → 3
    expect(estimateTokens('12345678')).toBe(3);
  });

  it('scales linearly with length', () => {
    const short = estimateTokens('hello');
    const long = estimateTokens('hello'.repeat(10));
    expect(long).toBeGreaterThan(short);
  });
});

// ---------------------------------------------------------------------------
// extractLastUserMessageText
// ---------------------------------------------------------------------------

describe('extractLastUserMessageText', () => {
  it('returns empty string for empty messages', () => {
    expect(extractLastUserMessageText([])).toBe('');
  });

  it('returns content of last user message (string form)', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'response' },
      { role: 'user', content: 'last user message' },
    ];
    expect(extractLastUserMessageText(msgs)).toBe('last user message');
  });

  it('extracts text parts from array content', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'image', url: 'ignored' },
          { type: 'text', text: 'world' },
        ],
      },
    ] as unknown as ModelMessage[];
    expect(extractLastUserMessageText(msgs)).toBe('hello\nworld');
  });

  it('skips non-user roles when finding last user message', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'the one' },
      { role: 'assistant', content: 'reply' },
    ];
    expect(extractLastUserMessageText(msgs)).toBe('the one');
  });

  it('returns empty string when no user message exists', () => {
    const msgs: ModelMessage[] = [{ role: 'assistant', content: 'reply' }];
    expect(extractLastUserMessageText(msgs)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// collectAssistantTextFromSteps
// ---------------------------------------------------------------------------

describe('collectAssistantTextFromSteps', () => {
  it('returns empty string for empty steps', () => {
    expect(collectAssistantTextFromSteps([])).toBe('');
  });

  it('joins non-empty step texts', () => {
    const steps = [{ text: 'step one' }, { text: '' }, { text: 'step two' }];
    expect(collectAssistantTextFromSteps(steps)).toBe('step one\nstep two');
  });

  it('handles steps with missing text field', () => {
    const steps = [{}, { text: 'only this' }] as Array<{ text?: string }>;
    expect(collectAssistantTextFromSteps(steps)).toBe('only this');
  });
});

// ---------------------------------------------------------------------------
// hasProjectMemoryToolCall
// ---------------------------------------------------------------------------

describe('hasProjectMemoryToolCall', () => {
  it('returns false for empty steps', () => {
    expect(hasProjectMemoryToolCall([])).toBe(false);
  });

  it('returns true when write_project_memory is called', () => {
    const steps = [{ toolCalls: [{ toolName: 'write_project_memory' }] }];
    expect(hasProjectMemoryToolCall(steps)).toBe(true);
  });

  it('returns false for other tool calls', () => {
    const steps = [{ toolCalls: [{ toolName: 'da_create_page' }] }];
    expect(hasProjectMemoryToolCall(steps)).toBe(false);
  });

  it('returns false for steps with no toolCalls', () => {
    const steps = [{ text: 'no tools here' }] as Array<{
      toolCalls?: Array<{ toolName?: string }>;
    }>;
    expect(hasProjectMemoryToolCall(steps)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldPersistMemoryFallback
// ---------------------------------------------------------------------------

describe('shouldPersistMemoryFallback', () => {
  it('returns false for empty assistant text', () => {
    expect(shouldPersistMemoryFallback('user question', '')).toBe(false);
  });

  it('returns false when assistant text starts with Error:', () => {
    expect(shouldPersistMemoryFallback('ask', 'Error: something failed')).toBe(false);
  });

  it('returns true for 2+ strong signal hits', () => {
    const user = 'Tell me about the navigation structure';
    const assistant = 'The site template uses a section-based navigation pattern.';
    expect(shouldPersistMemoryFallback(user, assistant)).toBe(true);
  });

  it('returns false for 0 signal hits', () => {
    const user = 'What is 2 + 2?';
    const assistant = 'Four.';
    expect(shouldPersistMemoryFallback(user, assistant)).toBe(false);
  });

  it('returns true for 1 signal + a question', () => {
    const user = 'What is the brand guideline?';
    const assistant = 'short answer';
    expect(shouldPersistMemoryFallback(user, assistant)).toBe(true);
  });

  it('returns true for 1 signal + long assistant response', () => {
    const user = 'describe the brand';
    const assistant = 'x'.repeat(221);
    expect(shouldPersistMemoryFallback(user, assistant)).toBe(true);
  });

  it('does NOT trigger on "url" or "site" alone', () => {
    const user = 'what is the url of the site?';
    const assistant = 'https://example.com';
    // "url" and "site" removed — zero signal hits → false
    expect(shouldPersistMemoryFallback(user, assistant)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// summarizeForMemory
// ---------------------------------------------------------------------------

describe('summarizeForMemory', () => {
  it('returns text unchanged when within maxLen', () => {
    expect(summarizeForMemory('short', 220)).toBe('short');
  });

  it('truncates and appends ellipsis when over maxLen', () => {
    const long = 'a'.repeat(250);
    const result = summarizeForMemory(long, 220);
    expect(result).toHaveLength(220);
    expect(result.endsWith('…')).toBe(true);
  });

  it('collapses multiple whitespace', () => {
    expect(summarizeForMemory('hello   world\n\nfoo')).toBe('hello world foo');
  });
});

// ---------------------------------------------------------------------------
// mergeMemoryWithFallback
// ---------------------------------------------------------------------------

describe('mergeMemoryWithFallback', () => {
  it('creates a new section when memory is null', () => {
    const result = mergeMemoryWithFallback(null, 'user input', 'assistant output');
    expect(result).toContain(AUTO_MEMORY_HEADER);
    expect(result).toContain('User context:');
  });

  it('creates a new section when memory is empty', () => {
    const result = mergeMemoryWithFallback('', 'user input', 'assistant output');
    expect(result).toContain(AUTO_MEMORY_HEADER);
  });

  it('appends section when existing memory has no auto-memory header', () => {
    const existing = '# My Memory\n\nSome manual notes.';
    const result = mergeMemoryWithFallback(existing, 'user', 'assistant');
    expect(result).toContain('# My Memory');
    expect(result).toContain(AUTO_MEMORY_HEADER);
  });

  it('prepends new entry inside existing auto-memory section', () => {
    const existing = `${AUTO_MEMORY_HEADER}\n- 2024-01-01T00:00:00.000Z | User context: old | Learned: old`;
    const result = mergeMemoryWithFallback(existing, 'new user', 'new assistant');
    const lines = result.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    // newest entry should be first
    expect(lines[0]).toContain('new user');
  });

  it('skips duplicate writes when stablePayload is unchanged', () => {
    const user = 'same user input';
    const assistant = 'same assistant output';
    const first = mergeMemoryWithFallback(null, user, assistant);
    const second = mergeMemoryWithFallback(first, user, assistant);
    // Body should be identical — no new entry added
    expect(second).toBe(first);
  });

  it('caps entries at MAX_AUTO_MEMORY_LINES (25)', () => {
    let memory: string | null = null;
    for (let i = 0; i < 30; i += 1) {
      memory = mergeMemoryWithFallback(memory, `user ${i}`, `assistant ${i}`);
    }
    const lines = memory!.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.length).toBeLessThanOrEqual(25);
  });
});
