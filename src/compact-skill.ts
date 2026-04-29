/** Compact Context skill content — inlined to avoid an esbuild .md loader requirement. */
const COMPACT_SKILL = `# Compact Context

Condenses the current conversation into a concise, structured summary that preserves all essential context while freeing space in the context window.

## When to use

- The system prompt signals **[AUTO-COMPACT TRIGGERED]** — the conversation has reached 75 % of the model's context-window capacity.
- The user explicitly asks to compact, summarize, or clear the conversation history.

## How to compact

Call the \`compact_context\` tool with a markdown summary that covers **all five** of these sections. Be thorough — the summary is the only record of what was discussed.

### Required summary sections

\`\`\`
# Conversation Summary

## Active task
One sentence: what is the user trying to accomplish right now?

## Site context
- org / site / current page path (if known)
- Purpose of the site (if known)
- Any URLs, templates, or structural patterns discovered

## Work completed
Bullet list of every concrete action taken: pages created or updated, content written, tools called and their outcomes. Include file paths.

## Pending items
What still needs to be done to finish the user's request, if anything.

## Key facts & preferences
Brand rules, style constraints, naming conventions, or explicit preferences the user stated. Only facts that would change future decisions.
\`\`\`

## After compacting

After \`compact_context\` returns:
1. Tell the user in one sentence that the conversation was compacted and their work is safe.
2. Show the **Active task** and **Pending items** sections so they know where you left off.
3. Continue helping — the summary has been emitted to the client. If the client supports compaction, the message history will be trimmed to this summary on the next turn.
`;

export default COMPACT_SKILL;
