import type { ModelMessage } from 'ai';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Approximate characters per token for English + code. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Rough token estimate from raw text/JSON.
 * Uses ~3.5 chars/token — good enough for triggering the compact heuristic.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Message extraction
// ---------------------------------------------------------------------------

export function extractLastUserMessageText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === 'user') {
      if (typeof msg.content === 'string') return msg.content.trim();
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .map((part) => {
            if (!part || typeof part !== 'object') return '';
            if ('type' in part && (part as { type?: string }).type !== 'text') return '';
            return String((part as { text?: unknown }).text ?? '').trim();
          })
          .filter(Boolean)
          .join('\n')
          .trim();
        if (text) return text;
      }
    }
  }
  return '';
}

export function collectAssistantTextFromSteps(steps: Array<{ text?: string }>): string {
  return steps
    .map((s) => String(s?.text ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function hasProjectMemoryToolCall(
  steps: Array<{ toolCalls?: Array<{ toolName?: string }> }>,
): boolean {
  return steps.some((step) =>
    (step.toolCalls ?? []).some((call) => call?.toolName === 'write_project_memory'),
  );
}

// ---------------------------------------------------------------------------
// Memory fallback heuristic
// ---------------------------------------------------------------------------

const MEMORY_SIGNALS = [
  'structure',
  'section',
  'navigation',
  'template',
  'url pattern',
  'information architecture',
  'brand',
  'workflow',
  'agent',
  'mcp',
  'skill',
  'content model',
  'project memory',
];

export function shouldPersistMemoryFallback(userText: string, assistantText: string): boolean {
  const assistantTrimmed = assistantText.trim();
  if (!assistantTrimmed || assistantTrimmed.startsWith('Error:')) return false;

  const combined = `${userText}\n${assistantText}`.toLowerCase();
  if (!combined.trim()) return false;

  const signalHits = MEMORY_SIGNALS.filter((signal) => combined.includes(signal));
  if (signalHits.length >= 2) return true;
  if (signalHits.length === 0) return false;
  // With one weak signal, require either a clear question or a substantial answer.
  return userText.includes('?') || assistantTrimmed.length > 220;
}

// ---------------------------------------------------------------------------
// Memory merge
// ---------------------------------------------------------------------------

export const AUTO_MEMORY_HEADER = '## Auto Memory Notes';
const MAX_AUTO_MEMORY_LINES = 25;

export function summarizeForMemory(text: string, maxLen = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1)}…`;
}

export function mergeMemoryWithFallback(
  existingMemory: string | null,
  userText: string,
  assistantText: string,
): string {
  const timestamp = new Date().toISOString();
  const userSummary = summarizeForMemory(userText || '(no user text)', 140);
  const assistantSummary = summarizeForMemory(assistantText || '(no assistant text)', 220);
  const stablePayload = `User context: ${userSummary} | Learned: ${assistantSummary}`;
  const entry = `- ${timestamp} | ${stablePayload}`;
  const body = String(existingMemory ?? '').trim();
  if (!body) return `${AUTO_MEMORY_HEADER}\n${entry}`;

  // Skip duplicate writes for repeated exchanges with equivalent summaries.
  if (body.includes(stablePayload)) return body;

  const headerIdx = body.indexOf(AUTO_MEMORY_HEADER);
  if (headerIdx < 0) return `${body}\n\n${AUTO_MEMORY_HEADER}\n${entry}`;

  const prefix = body.slice(0, headerIdx).trimEnd();
  const section = body.slice(headerIdx + AUTO_MEMORY_HEADER.length).trim();
  const existingLines = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
  const nextLines = [entry, ...existingLines].slice(0, MAX_AUTO_MEMORY_LINES);
  return `${prefix ? `${prefix}\n\n` : ''}${AUTO_MEMORY_HEADER}\n${nextLines.join('\n')}`;
}
