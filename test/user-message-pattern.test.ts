import { describe, expect, it } from 'vitest';
import {
  detectSessionUserPattern,
  trailingAssistantAlreadySuggestedSkill,
} from '../src/user-message-pattern.js';

describe('detectSessionUserPattern', () => {
  it('detects three identical user requests', () => {
    const messages = [
      { role: 'user', content: 'Check for typos' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Check for typos' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Check for typos' },
    ];
    const p = detectSessionUserPattern(messages);
    expect(p).not.toBeNull();
    expect(p!.excerpts.length).toBe(3);
    expect(p!.suggestedSkillId).toContain('check');
  });

  it('detects three paraphrased typo-check requests', () => {
    const messages = [
      { role: 'user', content: 'check typos' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'please check for typos' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'check for typos again' },
    ];
    const p = detectSessionUserPattern(messages);
    expect(p).not.toBeNull();
    expect(p!.excerpts.length).toBe(3);
  });

  it('returns null when fewer than three similar user turns', () => {
    const messages = [
      { role: 'user', content: 'Check for typos' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Check for typos' },
    ];
    expect(detectSessionUserPattern(messages)).toBeNull();
  });

  it('returns null when messages are unrelated', () => {
    const messages = [
      { role: 'user', content: 'Summarize this page' },
      { role: 'assistant', content: 'Here:' },
      { role: 'user', content: 'Add a hero block' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Change the footer color' },
    ];
    expect(detectSessionUserPattern(messages)).toBeNull();
  });
});

describe('trailingAssistantAlreadySuggestedSkill', () => {
  it('is true when the message before the last user has the tag', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'See [SKILL_SUGGESTION] below' },
      { role: 'user', content: 'b' },
    ];
    expect(trailingAssistantAlreadySuggestedSkill(messages)).toBe(true);
  });

  it('is false when the previous assistant has no tag', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'b' },
    ];
    expect(trailingAssistantAlreadySuggestedSkill(messages)).toBe(false);
  });
});
