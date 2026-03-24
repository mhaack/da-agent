import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import {
  streamText,
  stepCountIs,
  type ModelMessage,
} from 'ai';
import { z } from 'zod';
import { DAAdminClient } from './da-admin/client.js';
import { createDATools } from './tools/tools.js';
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
 * Scan messages for tool-approval-response entries, execute the approved tools
 * using the args stored in the preceding assistant message, and replace each
 * approval-response with a proper tool-result so streamText sees clean history.
 * Also strips the tool-approval-request parts from assistant messages.
 *
 * Dedup: the client keeps sending the original tool-approval-response forever
 * (the stream does not return resolved history). Only the last message can be a
 * fresh approval; older approval-response messages get a synthetic tool-result.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, no-plusplus, no-continue */
/* eslint-disable no-loop-func, no-await-in-loop -- chat payloads are loosely typed */
async function resolveApprovals(
  messages: any[],
  daTools: Record<string, any>,
): Promise<any[]> {
  // Shallow-clone the array; deep-clone content arrays we may mutate
  const result: any[] = messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? [...m.content] : m.content,
  }));

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;

    const approvalResp = msg.content.find((p: any) => p.type === 'tool-approval-response');
    if (!approvalResp) continue;

    const { approvalId, approved } = approvalResp;
    let toolCallId: string | undefined;
    let toolName: string | undefined;
    let toolArgs: any;

    // Walk backwards to find the assistant message with the matching approval-request
    for (let j = i - 1; j >= 0; j--) {
      const prev = result[j];
      if (prev.role !== 'assistant' || !Array.isArray(prev.content)) continue;

      const req = prev.content.find(
        (p: any) => p.type === 'tool-approval-request' && p.approvalId === approvalId,
      );
      if (!req) continue;

      toolCallId = req.toolCallId;
      const call = prev.content.find(
        (p: any) => p.type === 'tool-call' && p.toolCallId === toolCallId,
      );
      if (call) {
        toolName = call.toolName;
        toolArgs = call.input;
      }

      // Remove the approval-request part — streamText only needs the tool-call + tool-result
      prev.content = prev.content.filter(
        (p: any) => !(p.type === 'tool-approval-request' && p.approvalId === approvalId),
      );
      break;
    }

    if (!toolCallId || !toolName) continue;

    // A tool-approval-response that was already processed in a previous request
    // will have subsequent messages after it (e.g. assistant text, new user turns).
    // A NEW approval-response is always the last message (client appends it and sends).
    const alreadyResolved = i < result.length - 1;
    if (alreadyResolved) {
      const staleOutput = approved
        ? { type: 'text' as const, value: '(previously executed)' }
        : { type: 'json' as const, value: { message: 'Action rejected by user.' } };
      result[i] = {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName,
            output: staleOutput,
          },
        ],
      };
      continue;
    }

    let output: any;
    if (approved && daTools[toolName]?.execute) {
      try {
        output = await daTools[toolName].execute(toolArgs, { toolCallId, messages: [] });
      } catch (e) {
        output = { error: String(e) };
      }
    } else {
      output = { message: 'Action rejected by user.' };
    }

    const wrappedOutput = typeof output === 'string'
      ? { type: 'text', value: output }
      : { type: 'json', value: output };

    result[i] = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName,
          output: wrappedOutput,
        },
      ],
    };
  }

  return result;
}
/* eslint-enable @typescript-eslint/no-explicit-any, no-plusplus, no-continue */
/* eslint-enable no-loop-func, no-await-in-loop */

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

  const daTools = daClient
    ? createDATools(daClient, {
      pageContext: pageContext ?? undefined,
      collab: collab ?? undefined,
    })
    : {};

  const skills = daClient && pageContext
    ? await loadSkills(daClient, pageContext.org, pageContext.site)
    : [];

  // Process any pending tool approvals before passing messages to streamText.
  // The AI SDK's needsApproval is designed for stateful sessions; since each request
  // creates a fresh streamText call, we resolve approvals here instead.
  const processedMessages = await resolveApprovals(messages, daTools);

  const result = streamText({
    // model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
    model: bedrock('global.anthropic.claude-sonnet-4-6'),
    onError: (error) => {
      console.error('streamText error:', JSON.stringify(error));
      collab?.disconnect();
    },
    onFinish: () => {
      collab?.disconnect();
    },
    system: buildSystemPrompt(pageContext, skills),
    messages: processedMessages as ModelMessage[],
    tools: daTools,
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
