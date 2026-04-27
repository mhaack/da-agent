import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { z } from 'zod';
import { DAAdminClient } from './da-admin/client.js';
import { EDSAdminClient } from './eds-admin/client.js';
import { createCanvasClientTools, createDATools, createEDSTools } from './tools/tools.js';
import { ensureHtmlExtension, isCollabEligibleView } from './tools/utils.js';
import { createCollabClient } from './collab-client.js';
import { initTelemetry, flushTelemetry } from './telemetry.js';
import type { MCPServerConfig, BuiltInMCPServerConfig } from './mcp/types.js';
import { loadSkillsIndex, loadSkillContent } from './skills/loader.js';
import type { SkillsIndex } from './skills/loader.js';
import { loadAgentPreset } from './agents/loader.js';
import type { AgentPreset } from './agents/loader.js';
import { connectAndRegisterMCPTools } from './mcp/tool-adapter.js';
import { MCPClient } from './mcp/client.js';
import {
  loadApprovedGeneratedTools,
  loadGeneratedToolsIndex,
  buildGeneratedToolsPromptSection,
  type GeneratedToolsIndex,
} from './generated-tools/loader.js';
import { callSandbox } from './generated-tools/sandbox-client.js';
import { fetchProjectMemory } from './memory/loader.js';
import {
  detectSessionUserPattern,
  formatSessionPatternForPrompt,
  trailingAssistantAlreadySuggestedSkill,
  type SessionUserPattern,
} from './user-message-pattern.js';

const DA_OAUTH_CLIENT_ID = 'darkalley';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/** Loggable streamText / provider errors (Error#cause chains, non-enumerable fields). */
function formatErrorForLog(err: unknown): string {
  if (err instanceof Error) {
    const lines = [err.message];
    if (err.stack) lines.push(err.stack);
    let c: unknown = err.cause;
    let depth = 0;
    while (c instanceof Error && depth < 6) {
      lines.push(`Caused by: ${c.message}`);
      c = c.cause;
      depth += 1;
    }
    return lines.join('\n');
  }
  if (err && typeof err === 'object') {
    try {
      return JSON.stringify(err, null, 2);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

const PageContextSchema = z.object({
  org: z.string(),
  site: z.string(),
  path: z.string(),
  view: z.string().optional(),
});

/** Per MCP server: either a list of { name, value } or a header name → value map. */
const McpServerHeaderListSchema = z.array(z.object({ name: z.string().min(1), value: z.string() }));

const McpServerHeadersValueSchema = z.union([
  McpServerHeaderListSchema,
  z.record(z.string(), z.string()),
]);

/**
 * Normalize client MCP header payloads to a single Record for RemoteMCPServerConfig.
 */
function normalizeMcpHeadersInput(
  input: z.infer<typeof McpServerHeadersValueSchema> | undefined,
): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (Array.isArray(input)) {
    if (input.length === 0) return undefined;
    return Object.fromEntries(input.map(({ name, value }) => [name, value]));
  }
  if (Object.keys(input).length === 0) return undefined;
  return input;
}

const ChatRequestSchema = z.object({
  messages: z.array(z.any()),
  pageContext: PageContextSchema.optional(),
  imsToken: z.string().optional(),
  agentId: z.string().optional(),
  requestedSkills: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), z.string()).optional(),
  /** Optional HTTP headers per server id (keys must match mcpServers). Sent on every MCP request to that URL. */
  mcpServerHeaders: z.record(z.string(), McpServerHeadersValueSchema).optional(),
  /** Approved generated tool ids the client wants active for this request */
  requestedGeneratedTools: z.array(z.string()).optional(),
  attachments: z
    .array(
      z.object({
        id: z.string().min(1),
        fileName: z.string().min(1),
        mediaType: z.string().min(1),
        dataBase64: z.string().min(1),
        sizeBytes: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
});

type PageContext = z.infer<typeof PageContextSchema>;

/** Built-in MCP servers per environment, always added to every chat request. */
const GOVERNANCE_AGENT_INSTRUCTIONS = `\
Always use the **Live Preview URL** when interacting with the governance-agent — for both page evaluations and guideline retrieval. \
It always reflects the current document state without any preview/publish step needed.
"My/the brand guidelines" means guidelines for the current site, not the whole organization, unless the user says otherwise.`;

const BUILT_IN_MCP_SERVERS: Record<string, Record<string, BuiltInMCPServerConfig>> = {
  production: {
    'governance-agent': {
      type: 'http',
      url: 'https://adobe-aem-foundation-brand-governance-agent-deploy-9950ff.cloud.adobe.io/mcp/',
      sendImsToken: true,
      instructions: GOVERNANCE_AGENT_INSTRUCTIONS,
    },
  },
  ci: {
    'governance-agent': {
      type: 'http',
      url: 'https://brand-governance-agent-stage.adobe.io/mcp/',
      sendImsToken: true,
      instructions: GOVERNANCE_AGENT_INSTRUCTIONS,
    },
  },
  dev: {
    'governance-agent': {
      type: 'http',
      url: 'https://brand-governance-agent-stage.adobe.io/mcp/',
      // url: 'http://127.0.0.1:8000/mcp/',
      sendImsToken: true,
      instructions: GOVERNANCE_AGENT_INSTRUCTIONS,
    },
  },
};

function getBuiltInMcpServers(env: Env): Record<string, BuiltInMCPServerConfig> {
  return BUILT_IN_MCP_SERVERS[env.ENVIRONMENT ?? 'production'] ?? {};
}

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

    if (url.pathname === '/mcp-tools' && request.method === 'POST') {
      return handleMcpToolsList(request);
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
async function resolveApprovals(messages: any[], daTools: Record<string, any>): Promise<any[]> {
  const result: any[] = messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? [...m.content] : m.content,
  }));

  // 1. Build lookup: approvalId → { toolCallId, toolName, args, msgIdx }
  const approvalMeta = new Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      args: any;
      msgIdx: number;
    }
  >();
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
          const { toolCallId, toolName, args, msgIdx } = meta;

          // Strip the approval-request from the assistant message
          result[msgIdx].content = result[msgIdx].content.filter(
            (p: any) => !(p.type === 'tool-approval-request' && p.approvalId === resp.approvalId),
          );

          // Stale: processed in a prior request (has assistant/user msgs after it)
          if (i < lastConversationIdx) {
            result[i] = {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId,
                  toolName,
                  output: resp.approved
                    ? { type: 'text' as const, value: '(previously executed)' }
                    : { type: 'json' as const, value: { message: 'Action rejected by user.' } },
                },
              ],
            };
          } else {
            // Fresh: execute the tool or create rejection result
            let output: any;
            if (resp.approved && daTools[toolName]?.execute) {
              try {
                const cleanArgs = stripClientOnlyFromArgs(args);
                output = await daTools[toolName].execute(cleanArgs, { toolCallId, messages: [] });
              } catch (e) {
                output = { error: String(e) };
              }
            } else {
              output = { message: 'Action rejected by user.' };
            }

            result[i] = {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId,
                  toolName,
                  output:
                    typeof output === 'string'
                      ? { type: 'text', value: output }
                      : { type: 'json', value: output },
                },
              ],
            };
          }
        }
      }
    }
  }

  return result;
}
/* eslint-enable @typescript-eslint/no-explicit-any, no-await-in-loop */

/**
 * Remove client-only keys (e.g. revert snapshot) from tool-call inputs
 * before the model or tool execute sees them.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function stripClientOnlyToolInputs(messages: any[]): any[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((part: any) => {
      if (part.type !== 'tool-call' || !part.input || typeof part.input !== 'object') return part;
      const input = { ...part.input };
      let stripped = false;
      Object.keys(input).forEach((k) => {
        if (k.startsWith('_da')) {
          delete input[k];
          stripped = true;
        }
      });
      if (!stripped) return part;
      changed = true;
      return { ...part, input };
    });
    return changed ? { ...m, content } : m;
  });
}

function stripClientOnlyFromArgs(args: any): any {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  Object.keys(out).forEach((k) => {
    if (k.startsWith('_da')) delete out[k];
  });
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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

const McpToolsRequestSchema = z.object({
  servers: z.record(z.string(), z.string()),
  /** Optional HTTP headers per server id (keys should match servers). */
  serverHeaders: z.record(z.string(), McpServerHeadersValueSchema).optional(),
});

/**
 * Connect to the given MCP servers and list their individual tools.
 * Accepts POST { servers: { id: url, ... }, serverHeaders?: { id: [...] | { ... } } }.
 * Returns { servers: [{ id, tools: [{ name, description }], error? }] }.
 */
async function handleMcpToolsList(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400, headers: CORS_HEADERS });
  }

  const parsed = McpToolsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      'Expected { servers: Record<string, string>, serverHeaders?: Record<string, headerList | headerMap> }',
      {
        status: 400,
        headers: CORS_HEADERS,
      },
    );
  }

  const serverTools: Array<{
    id: string;
    tools: Array<{ name: string; description: string }>;
    error?: string;
  }> = [];

  const entries = Object.entries(parsed.data.servers);
  const clients: MCPClient[] = [];

  await Promise.all(
    entries.map(async ([serverId, serverUrl]) => {
      const headers = normalizeMcpHeadersInput(parsed.data.serverHeaders?.[serverId]);
      const client = new MCPClient(serverUrl, {
        timeout: 10000,
        ...(headers ? { headers } : {}),
      });
      try {
        await client.initialize();
        clients.push(client);
        const tools = await client.listTools();
        serverTools.push({
          id: serverId,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? `Tool from ${serverId}`,
          })),
        });
      } catch (e) {
        serverTools.push({
          id: serverId,
          tools: [],
          error: `Connection failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }),
  );

  await Promise.allSettled(clients.map((c) => c.close()));

  return new Response(JSON.stringify({ servers: serverTools }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function formatAttachmentsForModel(
  items: Array<{
    id: string;
    fileName: string;
    mediaType: string;
    sizeBytes?: number;
  }>,
): string {
  const lines: string[] = [
    'The user attached file(s). Binary contents are not available in chat context.',
    'If you need one for upload, call content_upload using attachmentRef from this list.',
    '',
    'Attached files:',
  ];
  items.forEach((item) => {
    const size = typeof item.sizeBytes === 'number' ? `, ${item.sizeBytes} bytes` : '';
    lines.push(`- [${item.id}] ${item.fileName} (${item.mediaType}${size})`);
  });
  return lines.join('\n');
}

function expandLatestUserAttachmentsForModel(
  messages: any[],
  attachmentMeta: Array<{
    id: string;
    fileName: string;
    mediaType: string;
    sizeBytes?: number;
  }>,
): any[] {
  if (!Array.isArray(attachmentMeta) || attachmentMeta.length === 0) {
    return messages.map((msg) => {
      if (msg.role !== 'user' || !msg || typeof msg !== 'object') return msg;
      const next = { ...msg };
      delete next.attachmentsMeta;
      return next;
    });
  }
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  return messages.map((msg, idx) => {
    if (msg.role !== 'user' || !msg || typeof msg !== 'object') return msg;
    const next = { ...msg };
    delete next.attachmentsMeta;
    if (idx !== lastUserIndex) return next;
    const userText = typeof next.content === 'string' ? next.content : String(next.content ?? '');
    const prefix = formatAttachmentsForModel(attachmentMeta);
    next.content = `${prefix}\n\n---\n\nUser message:\n${userText}`;
    return next;
  });
}

function extractImsUserId(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload));
    return decoded.user_id ?? decoded.sub ?? undefined;
  } catch {
    return undefined;
  }
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  initTelemetry(env);

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

  const {
    messages,
    pageContext,
    imsToken,
    agentId,
    requestedSkills,
    mcpServers,
    mcpServerHeaders,
    attachments = [],
  } = parsed.data;

  const attachmentMap = new Map(attachments.map((a) => [a.id, a]));

  const bedrock = createAmazonBedrock({
    region: env.AWS_REGION,
    apiKey: env.AWS_BEARER_TOKEN_BEDROCK,
  });

  const daOrigin = env.DA_ORIGIN ?? 'https://admin.da.live';
  const sourceUrl = `${daOrigin}/source/${pageContext?.org}/${pageContext?.site}/${ensureHtmlExtension(pageContext?.path ?? '')}`;

  const collab =
    isCollabEligibleView(pageContext?.view) && imsToken && env.DACOLLAB
      ? await createCollabClient(sourceUrl, imsToken, pageContext.org, env.DACOLLAB)
      : null;

  const adminClient =
    imsToken && env.DAADMIN
      ? new DAAdminClient({ apiToken: imsToken, daadminService: env.DAADMIN })
      : null;

  const edsClient = imsToken ? new EDSAdminClient({ apiToken: imsToken }) : null;

  const projectMemory =
    adminClient && pageContext
      ? await fetchProjectMemory(adminClient, pageContext.org, pageContext.site)
      : null;

  const daTools = createDATools(adminClient, {
    pageContext: pageContext ?? undefined,
    collab: collab ?? undefined,
    org: pageContext?.org,
    repo: pageContext?.site,
    resolveAttachmentByRef: (attachmentRef: string) => {
      const hit = attachmentMap.get(attachmentRef);
      if (!hit) return null;
      return {
        base64Data: hit.dataBase64,
        mimeType: hit.mediaType,
        fileName: hit.fileName,
      };
    },
  });
  const edsTools = edsClient ? createEDSTools(edsClient) : {};
  const canvasClientTools = createCanvasClientTools();

  // Build MCP config: user-provided servers merged with always-on built-in servers.
  const allMcpServers: Record<string, MCPServerConfig> = {};

  // User-provided servers — optional client-supplied headers on each MCP HTTP call
  for (const [id, url] of Object.entries(mcpServers ?? {})) {
    const headers = normalizeMcpHeadersInput(mcpServerHeaders?.[id]);
    allMcpServers[id] = {
      type: 'http',
      url,
      ...(headers ? { headers } : {}),
    };
  }

  const builtInServers = getBuiltInMcpServers(env);

  // Built-in servers — inject auth headers according to each server's config
  for (const [id, builtIn] of Object.entries(builtInServers)) {
    const headers: Record<string, string> = {};
    if (builtIn.sendImsToken && imsToken) {
      headers.Authorization = `Bearer ${imsToken}`;
      headers['x-api-key'] = DA_OAUTH_CLIENT_ID;
    }
    allMcpServers[id] = {
      type: builtIn.type,
      url: builtIn.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  const mcpConfig =
    Object.keys(allMcpServers).length > 0
      ? {
          mcpServers: allMcpServers,
          toolAllowPatterns: Object.keys(allMcpServers).map((id) => `mcp__${id}__*`),
        }
      : null;

  // Load skills index for system prompt injection
  let skillsIndex: SkillsIndex | null = null;
  if (adminClient && pageContext) {
    try {
      skillsIndex = await loadSkillsIndex(adminClient, pageContext.org, pageContext.site);
    } catch {
      // Skills loading is best-effort
    }
  }

  // Load agent preset if specified
  let activeAgent: AgentPreset | null = null;
  let agentSkillContents: Record<string, string> = {};
  if (adminClient && pageContext && agentId) {
    try {
      activeAgent = await loadAgentPreset(adminClient, pageContext.org, pageContext.site, agentId);
      if (activeAgent && activeAgent.skills.length > 0) {
        const entries = await Promise.all(
          activeAgent.skills.map(async (sid) => {
            try {
              const content = await loadSkillContent(
                adminClient,
                pageContext.org,
                pageContext.site,
                sid,
              );
              return content ? ([sid, content] as const) : null;
            } catch {
              return null;
            }
          }),
        );
        agentSkillContents = Object.fromEntries(entries.filter(Boolean) as [string, string][]);
      }
    } catch {
      // Agent loading is best-effort
    }
  }

  // Load explicitly requested skills (from slash commands)
  if (requestedSkills && requestedSkills.length > 0) {
    console.log('[da-agent] requestedSkills:', requestedSkills);
    if (adminClient && pageContext) {
      const entries = await Promise.all(
        requestedSkills.map(async (sid) => {
          if (agentSkillContents[sid]) return null;
          try {
            console.log(
              `[da-agent] loading skill "${sid}" for ${pageContext.org}/${pageContext.site}`,
            );
            const content = await loadSkillContent(
              adminClient,
              pageContext.org,
              pageContext.site,
              sid,
            );
            console.log(
              `[da-agent] skill "${sid}" loaded: ${content ? `${content.length} chars` : 'null'}`,
            );
            return content ? ([sid, content] as const) : null;
          } catch (e) {
            console.log(`[da-agent] skill "${sid}" error:`, e);
            return null;
          }
        }),
      );
      const loaded = Object.fromEntries(entries.filter(Boolean) as [string, string][]);
      agentSkillContents = { ...agentSkillContents, ...loaded };
      console.log('[da-agent] agentSkillContents keys:', Object.keys(agentSkillContents));
    } else {
      console.log(
        '[da-agent] cannot load skills: adminClient=',
        !!adminClient,
        'pageContext=',
        !!pageContext,
      );
    }
  }

  // Connect to live MCP servers and register their tools
  let mcpTools: Record<string, unknown> = {};
  let mcpClients: MCPClient[] = [];
  if (mcpConfig && Object.keys(mcpConfig.mcpServers).length > 0) {
    try {
      const mcpResult = await connectAndRegisterMCPTools(mcpConfig);
      mcpTools = mcpResult.tools;
      mcpClients = mcpResult.clients;
    } catch {
      // MCP connection failures don't block chat
    }
  }

  // Load approved generated tool defs and register stubs (execution delegates to sandbox).
  let generatedToolsIndex: GeneratedToolsIndex = { tools: [], source: 'none' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generatedToolStubs: Record<string, any> = {};
  if (adminClient && pageContext && env.GENERATED_TOOLS_ENABLED === 'true') {
    try {
      generatedToolsIndex = await loadGeneratedToolsIndex(
        adminClient,
        pageContext.org,
        pageContext.site,
      );
      const activeDefs = await loadApprovedGeneratedTools(
        adminClient,
        pageContext.org,
        pageContext.site,
      );
      const sandboxUrl: string | undefined = env.GENERATED_TOOLS_SANDBOX_URL;
      activeDefs.forEach((def) => {
        const toolName = `gen__${def.id}`;
        generatedToolStubs[toolName] = {
          description: def.description,
          parameters: def.inputSchema,
          // Execution is handled server-side: stub delegates to the sandbox Worker.
          execute: async (args: Record<string, unknown>) =>
            callSandbox(sandboxUrl, {
              toolId: def.id,
              org: pageContext.org,
              site: pageContext.site,
              args,
              imsToken: imsToken ?? undefined,
            }),
        };
      });
    } catch {
      // Generated tools loading is best-effort; never blocks chat
    }
  }

  // Process any pending tool approvals before passing messages to streamText.
  // The AI SDK's needsApproval is designed for stateful sessions; since each request
  // creates a fresh streamText call, we resolve approvals here instead.
  const allTools = {
    ...canvasClientTools,
    ...daTools,
    ...edsTools,
    ...mcpTools,
    ...generatedToolStubs,
  };

  const processedMessages = await resolveApprovals(messages, allTools);
  const strippedForModel = stripClientOnlyToolInputs(processedMessages);
  let sessionPattern: SessionUserPattern | null = null;
  if (!trailingAssistantAlreadySuggestedSkill(strippedForModel)) {
    sessionPattern = detectSessionUserPattern(strippedForModel);
  }
  const withSelectionContext = expandUserSelectionContextForModel(strippedForModel);
  const attachmentMeta = attachments.map((a) => ({
    id: a.id,
    fileName: a.fileName,
    mediaType: a.mediaType,
    ...(typeof a.sizeBytes === 'number' ? { sizeBytes: a.sizeBytes } : {}),
  }));
  const modelMessages = expandLatestUserAttachmentsForModel(withSelectionContext, attachmentMeta);

  const cleanupMCP = () => {
    mcpClients.forEach((c) => {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    });
  };

  const result = streamText({
    model: bedrock('global.anthropic.claude-sonnet-4-6'),
    onError: (error) => {
      console.error('[da-agent] streamText error:', formatErrorForLog(error));
      collab?.disconnect();
      cleanupMCP();
    },
    onFinish: async () => {
      await flushTelemetry();
      collab?.disconnect();
      cleanupMCP();
    },
    system: buildSystemPrompt(
      pageContext,
      mcpConfig,
      skillsIndex,
      activeAgent,
      agentSkillContents,
      generatedToolsIndex,
      projectMemory,
      sessionPattern,
      env.ENVIRONMENT,
      builtInServers,
    ),
    messages: modelMessages as ModelMessage[],
    tools: allTools,
    stopWhen: stepCountIs(5),
    experimental_telemetry: {
      isEnabled: true,
      functionId: 'da-agent-chat',
      metadata: {
        userId: extractImsUserId(imsToken) ?? 'unknown',
        org: pageContext?.org ?? 'unknown',
        site: pageContext?.site ?? 'unknown',
        path: pageContext?.path ?? 'unknown',
      },
    },
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

function buildMCPPromptSection(
  mcpConfig?: { mcpServers: Record<string, MCPServerConfig>; toolAllowPatterns: string[] } | null,
  builtInServers?: Record<string, BuiltInMCPServerConfig>,
): string {
  if (!mcpConfig || Object.keys(mcpConfig.mcpServers).length === 0) return '';
  const serverLines = Object.keys(mcpConfig.mcpServers)
    .map((id) => `- **${id}**: tools available as \`mcp__${id}__<toolName>\``)
    .join('\n');
  let section = `\n\n## Available MCP Servers\nThe following MCP servers have been discovered from the connected repository:\n${serverLines}\n\nTools from these servers follow the naming pattern \`mcp__<serverId>__<toolName>\`.`;
  const instructionEntries = Object.entries(builtInServers ?? {}).filter(([, s]) => s.instructions);
  if (instructionEntries.length > 0) {
    const instructionLines = instructionEntries
      .map(([id, s]) => `### ${id}\n${s.instructions}`)
      .join('\n\n');
    section += `\n\n### MCP Server Instructions\n${instructionLines}`;
  }
  return section;
}

function buildSkillsPromptSection(skillsIndex?: SkillsIndex | null): string {
  if (!skillsIndex || skillsIndex.skills.length === 0) return '';
  const lines = skillsIndex.skills.map((s) => `- **${s.id}**: ${s.title}`).join('\n');
  return `\n\n## Available Skills
The following skills are stored in the DA config \`skills\` sheet for this site. Use the da_get_skill tool to read a skill's full instructions before applying it.
${lines}

Skills may reference MCP tools by name. When applying a skill, read its full content first, then follow its instructions.`;
}

function buildAgentPromptSection(
  agent?: AgentPreset | null,
  skillContents?: Record<string, string>,
): string {
  let section = '';
  if (agent) {
    section += `\n\n## Active Agent: ${agent.name}\n${agent.description}\n\n### Agent Instructions\n${agent.systemPrompt}`;
  }
  if (skillContents && Object.keys(skillContents).length > 0) {
    section += '\n\n### Pre-loaded Skills';
    for (const [id, content] of Object.entries(skillContents)) {
      section += `\n\n#### Skill: ${id}\n${content}`;
    }
    section += "\n\nApply the above skill instructions whenever relevant to the user's request.";
  }
  return section;
}

function buildSystemPrompt(
  pageContext?: PageContext,
  mcpConfig?: { mcpServers: Record<string, MCPServerConfig>; toolAllowPatterns: string[] } | null,
  skillsIndex?: SkillsIndex | null,
  activeAgent?: AgentPreset | null,
  agentSkillContents?: Record<string, string>,
  generatedToolsIndex?: GeneratedToolsIndex | null,
  projectMemory?: string | null,
  sessionPattern?: SessionUserPattern | null,
  environment?: string,
  builtInServers?: Record<string, BuiltInMCPServerConfig>,
): string {
  const mcpSection = buildMCPPromptSection(mcpConfig, builtInServers);
  const skillsSection = buildSkillsPromptSection(skillsIndex);
  const agentSection = buildAgentPromptSection(activeAgent, agentSkillContents);
  const generatedToolsSection = generatedToolsIndex
    ? buildGeneratedToolsPromptSection(generatedToolsIndex)
    : '';
  const pathForUrl = pageContext
    ? `/${pageContext.path.replace(/^\//, '').replace(/\.html$/, '')}`
    : '';
  return `You are a helpful assistant for Document Authoring (DA) authoring platform.
You help users with questions about DA features, content authoring, and best practices.
Use the available tools to search documentation and provide accurate information.
Always provide helpful, accurate responses. You must never refer to the platform as "Dark Alley" or "DA".

CRITICAL INSTRUCTION - TOOL USAGE:
- For bulk preview, publish, or unpublish (live delete) of multiple DA pages in the canvas workspace, use the matching bulk canvas tools (run in the browser). Do not claim the operation finished until the user completes or dismisses the dialog.
- When bulk publish returns publishedUrls, include those URLs directly in your response so the user can open the live pages.
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

## Rich Response Formatting
When presenting structured information in your responses (NOT in HTML content for tools), use these block syntaxes for richer display. Wrap content in triple-colon fences:

**Lists** — bullet lists with visual styling:
\`\`\`
:::list
- First item
- Second item
- Third item
:::
\`\`\`

**Checklists** — visual check/cross markers:
\`\`\`
:::checklist
- [x] Completed item
- [ ] Pending item
:::
\`\`\`

**Alerts** — info, warning, or error callouts:
\`\`\`
:::alert-info
This is an informational note.
:::

:::alert-warning
This needs attention.
:::

:::alert-error
This is a critical issue.
:::
\`\`\`

**Toggle lists** — expandable sections:
\`\`\`
:::toggle-list
> Section title
  Details that expand when clicked.
> Another section
  More details here.
:::
\`\`\`

Use these blocks when they improve readability — for example, checklists for audits, alerts for important notes, toggle lists for detailed breakdowns. Do NOT overuse them for simple responses.

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

**Images**
- To add an image to the page, use the content_upload tool to upload the image. After this point, only the contentUrl is available, not the other image urls.
- If you are asked to add an image to the page that you uploaded with the content_upload tool, ALWAYS use the contentUrl returned by the tool call as the src attribute.

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
- Live Preview URL: https://main--${pageContext.site}--${pageContext.org}.${environment === 'production' || !environment ? 'preview.da.live' : 'stage-preview.da.live'}${pathForUrl}
- Previewed URL: https://main--${pageContext.site}--${pageContext.org}.aem.page${pathForUrl}
- Published URL: https://main--${pageContext.site}--${pageContext.org}.aem.live${pathForUrl}

**URL freshness rules:**
- The **Live Preview URL** always reflects the current state of the document as it appears right now in DA — no operation needed.
- The **Previewed URL** only reflects the latest content after a **preview** operation has been performed; otherwise it is outdated.
- The **Published URL** only reflects the latest content after a **publish** operation has been performed (which takes content from the Previewed URL); otherwise it is outdated.

When making DA tool calls, always use these values:
- org: "${pageContext.org}"
- repo: "${pageContext.site}"
- path: "${ensureHtmlExtension(pageContext.path)}"
${
  isCollabEligibleView(pageContext.view)
    ? `
## Edit / canvas view — Content Update Rules
The user is in the document editor (classic edit or canvas). Apply these rules for EVERY message in this session:

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
    projectMemory
      ? `
## Project Memory
The following is long-lived memory about this site, accumulated from previous sessions:

${projectMemory}

Use this context to better understand the site before taking any actions.
`
      : ''
  }${
    pageContext
      ? `
## Memory Instructions
At the end of every response where you have learned something about this site, you MUST call write_project_memory to persist what you know.
This includes: answering questions about the site structure, listing pages, reading content to understand the site, or any interaction that reveals the site's purpose, main sections, URL patterns, templates, or content conventions.
Always write the full updated markdown — include everything you know, not just what changed.
IMPORTANT: Writing about what you learned in your text response does NOT save it. Only an actual write_project_memory tool call saves to memory. Never say "I've saved this" or "I'll remember this" without calling the tool.
Do NOT call it for pure content edits where you learned nothing new about the site's structure.
`
      : ''
  }${mcpSection}${skillsSection}${agentSection}${generatedToolsSection}

## Skill Suggestions
The server may append **Session pattern detected** when it automatically finds several similar user messages in this thread (any topic — not a fixed list). When that section is present, you MUST output the \`[SKILL_SUGGESTION]\` block in the same reply.

When there is no server pattern block, you may still suggest a skill on your own if you notice repeated, specific instructions across messages and no existing skill covers them.

### First offer / draft (preferred for new skills the user has not asked to persist yet)
Use the \`[SKILL_SUGGESTION]\` block below so the client shows the **yellow in-chat card** with **Create Skill** and **Dismiss**. Do **not** call \`da_create_skill\` for that first offer—calling the tool skips that UX and is only for explicit persistence.

### When the user clearly asks to save, write, or persist a skill to the config (no suggestion card needed)
- Call **da_create_skill** with kebab-case \`skillId\` and full markdown \`content\`.
- After the tool succeeds, confirm briefly (skill id only); do **not** repeat the full skill body in your message.

### \`[SKILL_SUGGESTION]\` block — exact shape for the yellow "Create Skill" UI
The client detects a fixed pattern. If you include it, the user sees **Create Skill** with the draft pre-filled. Use this **exact** structure (replace only the id, optional intro line, and markdown between the markers). Do **not** wrap this block in markdown code fences (\`\`\`); do not bold the \`[SKILL_SUGGESTION]\` line.

[SKILL_SUGGESTION]

One short sentence for the human (optional).

SKILL_ID: my-suggested-skill-id

---SKILL_CONTENT_START---
# Skill title

Full markdown skill content for the DA config \`skills\` sheet.
---SKILL_CONTENT_END---

Rules:
- The token \`[SKILL_SUGGESTION]\` must appear as its own line, exactly (square brackets, no formatting around it).
- \`SKILL_ID:\` is one line; use lowercase letters, digits, hyphens only.
- \`---SKILL_CONTENT_START---\` and \`---SKILL_CONTENT_END---\` must match exactly; put the skill body between them, including leading \`#\` title.

### Proactive suggestions (only after 2–3 similar, repeatable requests)
Suggest only when the pattern is specific (not generic Q&A) and no existing skill covers it. Output the \`[SKILL_SUGGESTION]\` block with a concrete draft first. Only call **da_create_skill** after the user clearly wants it written to the config without using the chat card.${
    sessionPattern ? formatSessionPatternForPrompt(sessionPattern) : ''
  }`;
}
