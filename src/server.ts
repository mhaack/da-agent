import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type ToolSet
} from "ai";
import { z } from "zod";
import { DAAdminClient } from "./da-admin/client";
import { createDATools } from "./tools/tools";

const PageContextSchema = z.object({
  org: z.string(),
  site: z.string(),
  path: z.string(),
  view: z.string().optional()
});

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const pageContextResult = PageContextSchema.safeParse(
      options?.body?.pageContext
    );
    const pageContext = pageContextResult.success
      ? pageContextResult.data
      : undefined;
    const imsToken = options?.body?.imsToken as string | undefined;

    console.log("pageContext:", pageContext);

    const bedrock = createAmazonBedrock({
      region: this.env.AWS_REGION,
      apiKey: this.env.AWS_BEARER_TOKEN_BEDROCK
    });

    const daTools = imsToken
      ? createDATools(
          new DAAdminClient({
            apiToken: imsToken,
            daadminService: this.env.DAADMIN
          })
        )
      : {};

    const result = streamText({
      model: bedrock("anthropic.claude-3-5-sonnet-20241022-v2:0"),
      onError: (error) => console.error("streamText error:", JSON.stringify(error)),
      system: `You are a helpful assistant for Document Authoring (DA) authoring platform.
You help users with questions about DA features, content authoring, and best practices.
Use the available tools to search documentation and provide accurate information.
Always provide helpful, accurate responses. You must never refer to the platform as "Dark Alley" or "DA".

CRITICAL INSTRUCTION - TOOL USAGE:
- NEVER mention tool names in your response text
- NEVER say "I'll use", "Let me call", "using the function", "da_get_source", "da_update_source" or similar
- NEVER explain that you are calling a tool or function
- Simply perform the action and describe the RESULT, not the process
- Bad: "I'll retrieve the content using da_get_source..."
- Good: "Here's the current content of this page:"
- Bad: "Let me update that using da_update_source..."
- Good: "Done! The page now contains..."

## EDS HTML Content Rules
ALL content you create or update via tools MUST be valid Edge Delivery Services (EDS) semantic HTML. Follow these rules strictly:

**Page structure**
- Wrap all page content in \`<main>\`
- Divide content into sections using \`<hr>\` as a section separator
- Each section is an implicit \`<div>\` grouping content between two \`<hr>\` tags

**Blocks**
- Represent EDS blocks as \`<div class="block-name">\` elements
- Each row of block content is a child \`<div>\`
- Each column within a row is a nested \`<div>\`, containing normal semantic HTML
- For block variants add additional classes (e.g., \`<div class="cards full-width">\`)
- Example:
  \`\`\`html
  <div class="hero">
    <div>
      <div><h2>Title</h2><p>Subtitle text</p></div>
      <div><img src="..." alt="..."></div>
    </div>
  </div>
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
- path: ${pageContext.path}
- view: ${pageContext.view}

When making DA tool calls, always use these values:
- org: "${pageContext.org}"
- repo: "${pageContext.site}"
- path: "${pageContext.path}"`
    : ""
}`,
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: daTools,
      onFinish,
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
