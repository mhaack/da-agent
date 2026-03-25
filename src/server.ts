import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import {
  streamText,
  stepCountIs,
  type ModelMessage,
} from 'ai';
import { z } from 'zod';
import { DAAdminClient } from './da-admin/client.js';
import { EDSAdminClient } from './eds-admin/client.js';
import { createDATools, createEDSTools } from './tools/tools.js';
import { ensureHtmlExtension } from './tools/utils.js';
import { createCollabClient } from './collab-client.js';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const PageContextSchema = z.object({
  org: z.string(),
  site: z.string(),
  path: z.string(),
  view: z.string().optional(),
});

const ChatRequestSchema = z.object({
  messages: z.array(z.any()),
  pageContext: PageContextSchema.optional(),
  imsToken: z.string().optional(),
});

type PageContext = z.infer<typeof PageContextSchema>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname === '/chat') {
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: CORS_HEADERS });
      }
      if (request.method === 'POST') {
        return handleChat(request, env);
      }
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Resolve tool-approval-response messages into standard tool-result messages
 * so that streamText receives clean history.
 *
 * 1. Build a lookup of approvalId → tool metadata from assistant messages.
 * 2. Determine which approval-responses are "fresh" (appended by the client
 *    in this request) vs "stale" (processed in a prior request). Fresh ones
 *    sit after the last assistant/user message; stale ones have the LLM's
 *    continuation after them.
 * 3. Fresh approvals are executed; stale ones get a synthetic result.
 * 4. Strips tool-approval-request parts from assistant messages.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, no-await-in-loop */
async function resolveApprovals(
  messages: any[],
  daTools: Record<string, any>,
): Promise<any[]> {
  const result: any[] = messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? [...m.content] : m.content,
  }));

  // 1. Build lookup: approvalId → { toolCallId, toolName, args, msgIdx }
  const approvalMeta = new Map<string, {
    toolCallId: string; toolName: string; args: any; msgIdx: number;
  }>();
  for (let i = 0; i < result.length; i += 1) {
    const msg = result[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool-approval-request') {
          const call = msg.content.find(
            (p: any) => p.type === 'tool-call' && p.toolCallId === part.toolCallId,
          );
          if (call) {
            approvalMeta.set(part.approvalId, {
              toolCallId: part.toolCallId,
              toolName: call.toolName,
              args: call.input,
              msgIdx: i,
            });
          } else {
            // approval-request with no matching tool-call — skip
          }
        }
      }
    }
  }

  if (approvalMeta.size === 0) return result;

  // 2. Find the last assistant/user message index.
  //    Approval-responses AFTER this index are fresh (just appended by the client).
  //    Approval-responses BEFORE it are stale (processed in a prior request,
  //    with the LLM's continuation appearing after them).
  let lastConversationIdx = -1;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i].role === 'assistant' || result[i].role === 'user') {
      lastConversationIdx = i;
      break;
    }
  }
  // 3. Process each approval-response → replace with a tool-result
  for (let i = 0; i < result.length; i += 1) {
    const msg = result[i];
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      const resp = msg.content.find((p: any) => p.type === 'tool-approval-response');
      if (resp) {
        const meta = approvalMeta.get(resp.approvalId);
        if (meta) {
          const {
            toolCallId, toolName, args, msgIdx,
          } = meta;

          // Strip the approval-request from the assistant message
          result[msgIdx].content = result[msgIdx].content.filter(
            (p: any) => !(p.type === 'tool-approval-request' && p.approvalId === resp.approvalId),
          );

          // Stale: processed in a prior request (has assistant/user msgs after it)
          if (i < lastConversationIdx) {
            result[i] = {
              role: 'tool',
              content: [{
                type: 'tool-result',
                toolCallId,
                toolName,
                output: resp.approved
                  ? { type: 'text' as const, value: '(previously executed)' }
                  : { type: 'json' as const, value: { message: 'Action rejected by user.' } },
              }],
            };
          } else {
            // Fresh: execute the tool or create rejection result
            let output: any;
            if (resp.approved && daTools[toolName]?.execute) {
              try {
                output = await daTools[toolName].execute(args, { toolCallId, messages: [] });
              } catch (e) {
                output = { error: String(e) };
              }
            } else {
              output = { message: 'Action rejected by user.' };
            }

            result[i] = {
              role: 'tool',
              content: [{
                type: 'tool-result',
                toolCallId,
                toolName,
                output: typeof output === 'string'
                  ? { type: 'text', value: output }
                  : { type: 'json', value: output },
              }],
            };
          }
        }
      }
    }
  }

  return result;
}
/* eslint-enable @typescript-eslint/no-explicit-any, no-await-in-loop */

const SKILLS_PATH = '.da/skills';

async function loadSkills(client: DAAdminClient, org: string, site: string): Promise<string[]> {
  try {
    const listing = await client.listSources(org, site, SKILLS_PATH);
    const mdFiles = listing.filter((s) => s.ext === 'md');
    console.log(`Skills: found ${mdFiles.length} skill(s) in ${org}/${site}/${SKILLS_PATH}:`, mdFiles.map((f) => f.name));
    // Paths from list API are absolute (/{org}/{site}/...) — strip prefix for getSource
    const pathPrefix = `/${org}/${site}/`;
    const results = await Promise.all(
      mdFiles.map((f) => {
        const relativePath = f.path.startsWith(pathPrefix)
          ? f.path.slice(pathPrefix.length)
          : f.path;
        return client.getSource(org, site, relativePath)
          .then((r) => r as unknown as string)
          .catch((e) => {
            console.log(`Skills: failed to load ${f.name}:`, e);
            return null;
          });
      }),
    );
    const loaded = results.filter(Boolean) as string[];
    console.log(`Skills: successfully loaded ${loaded.length}/${mdFiles.length} skill(s)`);
    return loaded;
  } catch {
    console.log(`Skills: no skills folder found at ${org}/${site}/${SKILLS_PATH}`);
    return [];
  }
}

/**
 * Turn per-message selectionContext (page excerpts from quick-edit) into text the model can use.
 * Strips selectionContext from the payload so streamText receives plain CoreMessages.
 */
function formatSelectionContextForModel(items: any[]): string {
  const lines: string[] = [
    'The user attached the following excerpt(s) from the page they are editing. Treat this as authoritative context for their message. Indices refer to positions in the collaborative editor document.',
    '',
  ];
  items.forEach((item, i) => {
    const idx = typeof item?.proseIndex === 'number' ? item.proseIndex : '?';
    let label = 'Prose section';
    if (typeof item?.blockName === 'string' && item.blockName.trim()) {
      label = `Block "${item.blockName.trim()}"`;
    }
    const body = typeof item?.innerText === 'string' ? item.innerText.trim() : '';
    lines.push(`${i + 1}. ${label} (editor index: ${idx})`);
    if (body) lines.push(`   Content: ${body}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function expandUserSelectionContextForModel(messages: any[]): any[] {
  return messages.map((msg) => {
    if (msg.role !== 'user') return msg;
    const items = msg.selectionContext;
    if (!Array.isArray(items) || items.length === 0) {
      const rest = { ...msg };
      delete rest.selectionContext;
      return rest;
    }
    const userText = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
    const prefix = formatSelectionContextForModel(items);
    const content = `${prefix}\n\n---\n\nUser message:\n${userText}`;
    return { role: 'user', content };
  });
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response('Invalid request body', { status: 400 });
  }

  const { messages, pageContext, imsToken } = parsed.data;

  const bedrock = createAmazonBedrock({
    region: env.AWS_REGION,
    apiKey: env.AWS_BEARER_TOKEN_BEDROCK,
  });

  const daOrigin = env.DA_ORIGIN ?? 'https://admin.da.live';
  const sourceUrl = `${daOrigin}/source/${pageContext?.org}/${pageContext?.site}/${ensureHtmlExtension(pageContext?.path ?? '')}`;

  const collab = pageContext?.view === 'edit' && imsToken && env.DACOLLAB
    ? await createCollabClient(sourceUrl, imsToken, pageContext.org, env.DACOLLAB)
    : null;

  const daClient = imsToken && env.DAADMIN
    ? new DAAdminClient({ apiToken: imsToken, daadminService: env.DAADMIN })
    : null;

  const edsClient = imsToken
    ? new EDSAdminClient({ apiToken: imsToken })
    : null;

  const daTools = createDATools(daClient, {
    pageContext: pageContext ?? undefined,
    collab: collab ?? undefined,
  });
  const edsTools = edsClient ? createEDSTools(edsClient) : {};
  const tools = { ...daTools, ...edsTools };

  const skills = daClient && pageContext
    ? await loadSkills(daClient, pageContext.org, pageContext.site)
    : [];

  // Process any pending tool approvals before passing messages to streamText.
  // The AI SDK's needsApproval is designed for stateful sessions; since each request
  // creates a fresh streamText call, we resolve approvals here instead.
  const processedMessages = await resolveApprovals(messages, tools);
  const modelMessages = expandUserSelectionContextForModel(processedMessages);

  const result = streamText({
    model: bedrock('global.anthropic.claude-sonnet-4-6'),
    onError: (error) => {
      console.error('streamText error:', JSON.stringify(error));
      collab?.disconnect();
    },
    onFinish: () => {
      collab?.disconnect();
    },
    system: buildSystemPrompt(pageContext, skills),
    messages: modelMessages as ModelMessage[],
    tools,
    stopWhen: stepCountIs(5),
  });

  const streamResponse = result.toUIMessageStreamResponse();

  const headers = new Headers(streamResponse.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(streamResponse.body, {
    status: streamResponse.status,
    headers,
  });
}

function buildSystemPrompt(pageContext?: PageContext, skills: string[] = []): string {
  return `You are a helpful assistant for Document Authoring (DA) authoring platform.
You help users with questions about DA features, content authoring, and best practices.
Use the available tools to search documentation and provide accurate information.
Always provide helpful, accurate responses. You must never refer to the platform as "Dark Alley" or "DA".

CRITICAL INSTRUCTION - TOOL USAGE:
- NEVER mention tool names in your response text
- NEVER explain that you are calling a tool or function
- Simply perform the action and describe the RESULT, not the process
- NEVER output raw HTML in your response text — no code blocks, no inline HTML, no previews
- Bad: "I'll retrieve the content using da_get_source..."
- Good: "Here's the current content of this page:"
- Bad: "Let me update that using da_update_source..."
- Good: "Done! The page now contains..."
- Bad: "Here is the updated HTML: \`\`\`html <body>...</body> \`\`\`"
- Good: (call the update tool directly, then confirm in plain prose)

## EDS HTML Content Rules
ALL content you create or update via tools MUST be valid Edge Delivery Services (EDS) semantic HTML. Follow these rules strictly:

**Document structure**
- The content string MUST start with \`<body>\` and end with \`</body>\`
- Inside \`<body>\`, wrap all page content in \`<main>\`
- Inside \`<main>\`, wrap all page content in \`<div>\` which is called a section.
- Every page must have at least one section.
- Start a new section with a new top level \`<div>\` tag, do not use \`<hr>\` for this.
- Minimal valid structure: \`<body><main><div>...</div></main></body>\`
- NEVER wrap the content in \`<![CDATA[…]]>\`, XML declarations, \`<!DOCTYPE>\`, \`<html>\`, or \`<head>\` tags
- The content passed to create/update tools MUST be a plain HTML string — no markdown code fences, no JSON encoding, no escaping of angle brackets

**Blocks**
- Represent EDS blocks as \`<div class="block-name">\` elements
- Each row of block content is a child \`<div>\`
- Each column within a row is a nested \`<div>\`, containing normal semantic HTML
- For block variants add additional classes (e.g., \`<div class="cards full-width">\`)
- Example:
  \`\`\`html
  <body>
    <main>
      <div>
        <div class="hero">
          <div>
            <div><h2>Title</h2><p>Subtitle text</p>
            <img src="..." alt="..."></div>
          </div>
        </div>
        <p>...</p>
        <div class="cards full-width">
          <div>
            <div><h2>Title</h2><p>Subtitle text</p></div>
            <div><img src="..." alt="..."></div>
          </div>
          <div>
            <div><h2>Title</h2><p>Subtitle text</p></div>
            <div><img src="..." alt="..."></div>
          </div>
        </div>
      </div>
    </main>
  </body>
  \`\`\`

**Semantic HTML**
- Use proper heading hierarchy: \`<h1>\` for page title, \`<h2>\`–\`<h6>\` for sections
- Use \`<p>\`, \`<ul>\`, \`<ol>\`, \`<li>\`, \`<a>\`, \`<strong>\`, \`<em>\` as appropriate
- Use \`<img>\` with descriptive \`alt\` attributes for all images
- NEVER use inline styles (\`style="..."\`)
- NEVER use non-semantic \`<div>\` or \`<span>\` for layout outside of block tables
${
  pageContext
    ? `
## Current Page Context
The user is currently working on the following document in DA (Document Authoring):
- org: ${pageContext.org}
- site (repo): ${pageContext.site}
- path: ${ensureHtmlExtension(pageContext.path)}
- view: ${pageContext.view}

When making DA tool calls, always use these values:
- org: "${pageContext.org}"
- repo: "${pageContext.site}"
- path: "${ensureHtmlExtension(pageContext.path)}"
${
  pageContext.view === 'edit'
    ? `
## Edit View — Content Update Rules
The user is in the document editor. Apply these rules for EVERY message in this session:

**Reading before writing**
- ALWAYS call the get content tool to read the current page content before making any changes
- Never assume or invent the current content — always fetch it first

**Writing changes**
- For ANY content change the user requests (edits, rewrites, additions, deletions, reformatting) you MUST call the update content tool — never describe, preview, or return HTML in your response text
- NEVER output HTML in your response — not as a code block, not as plain text, not as a preview
- NEVER ask the user to copy-paste HTML — always write it directly via the tool
- Apply ALL requested changes in a single update call — do not make partial updates

**After updating**
- Briefly confirm what was changed in plain prose (e.g. "Updated the hero headline and added a cards block with three items.")
- Never repeat or quote the HTML back to the user`
    : ''
}`
    : ''
}${
  skills.length > 0
    ? `

## Custom Skills
The following skills define custom workflows configured for this site. When the user's request matches a skill, follow its instructions precisely:

${skills.join('\n\n---\n\n')}`
    : ''
}`;
}
