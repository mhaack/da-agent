/**
 * Detect repeated or near-duplicate user intents from chat history (no domain keywords).
 * Used to drive skill suggestions when the user asks for the same kind of thing multiple times.
 */

const MIN_MESSAGES = 3;
/** At least this many non-trivial tokens per user turn to count toward a pattern. */
const MIN_TOKENS_PER_MESSAGE = 2;
/** Jaccard similarity on word sets (after light normalization). */
const SIMILARITY_THRESHOLD = 0.42;

/** Very common fillers — linguistic, not task-specific. */
const STOP = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'and',
  'or',
  'in',
  'on',
  'at',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'this',
  'that',
  'you',
  'your',
  'me',
  'my',
  'we',
  'our',
  'they',
  'their',
  'i',
  'of',
  'as',
  'by',
  'with',
  'from',
  'please',
  'can',
  'could',
  'would',
  'should',
  'just',
  'also',
  'very',
  'really',
  'some',
  'any',
  'all',
  'do',
  'does',
  'did',
  'so',
  'if',
  'not',
  'no',
  'yes',
  'ok',
  'okay',
  'thanks',
  'thank',
]);

export type SessionUserPattern = {
  /** Up to three example user messages shown to the model. */
  excerpts: string[];
  /** Kebab-case hint for SKILL_ID. */
  suggestedSkillId: string;
};

/** Appended to the system prompt when a repetition pattern is detected. */
export function formatSessionPatternForPrompt(pattern: SessionUserPattern): string {
  const quoted = pattern.excerpts.map((t, i) => `${i + 1}. ${JSON.stringify(t)}`).join('\n');
  return `\n\n## Session pattern detected (server analysis)
Automated analysis of this conversation found at least three user messages with the same or very similar intent (word overlap). This is not tied to any fixed list of tasks — it works for any repeated phrasing.

Example user messages:
${quoted}

**Mandatory for this reply:** Include one complete \`[SKILL_SUGGESTION]\` block using the exact structure in "Skill Suggestions" below. Set \`SKILL_ID:\` to \`${pattern.suggestedSkillId}\` (adjust slightly only if required for clarity). The skill body must describe how to handle this class of requests in future sessions.`;
}

function extractUserStringContent(msg: { role?: string; content?: unknown }): string {
  if (msg.role !== 'user') return '';
  const { content } = msg;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

/**
 * Strip attachment / selection wrappers so we compare the user's actual words.
 */
function userIntentText(raw: string): string {
  let s = raw.trim();
  const marker = '\n\n---\n\nUser message:\n';
  const idx = s.lastIndexOf(marker);
  if (idx !== -1) s = s.slice(idx + marker.length).trim();
  return s;
}

function meaningfulTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (w.length >= 2 && !STOP.has(w)) {
      out.add(w);
    }
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function normalizeExact(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/gi, '')
    .trim();
}

function suggestedSkillIdFromTexts(samples: string[]): string {
  const combined = samples.join(' ').slice(0, 240);
  const words = combined.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const slugParts = words.filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 6);
  if (slugParts.length === 0) return 'repeatable-workflow';
  let id = slugParts.join('-');
  if (id.length > 52) id = id.slice(0, 52).replace(/-+$/, '');
  return id;
}

/**
 * Returns a pattern when the latest user message is part of a group of at least MIN_MESSAGES
 * user turns that are pairwise similar (same normalized text OR high Jaccard on meaningful tokens).
 */
export function detectSessionUserPattern(messages: unknown[]): SessionUserPattern | null {
  const userTexts: string[] = [];
  for (const m of messages) {
    if (m && typeof m === 'object') {
      const msg = m as { role?: string; content?: unknown };
      const raw = extractUserStringContent(msg);
      const intent = userIntentText(raw);
      if (intent) {
        const tokens = meaningfulTokens(intent);
        if (tokens.size >= MIN_TOKENS_PER_MESSAGE) {
          userTexts.push(intent);
        }
      }
    }
  }

  if (userTexts.length < MIN_MESSAGES) return null;

  const last = userTexts[userTexts.length - 1];
  const lastNorm = normalizeExact(last);
  const lastTokens = meaningfulTokens(last);

  const similarIndices: number[] = [];
  for (let i = 0; i < userTexts.length; i += 1) {
    const t = userTexts[i];
    const n = normalizeExact(t);
    if (n === lastNorm && n.length >= 4) {
      similarIndices.push(i);
    } else {
      const sim = jaccard(lastTokens, meaningfulTokens(t));
      if (sim >= SIMILARITY_THRESHOLD) {
        similarIndices.push(i);
      }
    }
  }

  if (similarIndices.length < MIN_MESSAGES) return null;

  const excerpts = similarIndices.slice(-MIN_MESSAGES).map((i) => userTexts[i]);
  const suggestedSkillId = suggestedSkillIdFromTexts(excerpts);

  return { excerpts, suggestedSkillId };
}

function messageContainsSkillTag(msg: { content?: unknown }): boolean {
  const c = msg.content;
  if (typeof c === 'string') return c.includes('[SKILL_SUGGESTION]');
  if (Array.isArray(c)) {
    for (const part of c) {
      if (
        part &&
        typeof part === 'object' &&
        part.type === 'text' &&
        typeof part.text === 'string'
      ) {
        if (part.text.includes('[SKILL_SUGGESTION]')) return true;
      }
    }
  }
  return false;
}

/**
 * True when the assistant turn immediately before the latest user message already
 * included a skill suggestion (avoid back-to-back duplicate blocks).
 */
export function trailingAssistantAlreadySuggestedSkill(messages: unknown[]): boolean {
  if (messages.length < 2) return false;
  const prev = messages[messages.length - 2];
  if (!prev || typeof prev !== 'object') return false;
  const msg = prev as { role?: string; content?: unknown };
  if (msg.role !== 'assistant') return false;
  return messageContainsSkillTag(msg);
}
