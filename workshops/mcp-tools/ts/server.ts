/**
 * Nevermined Lab: MCP — Monetized MCP Server
 *
 * Complete MCP server with paid tools, resources, and prompts.
 * One class handles everything: OAuth, token validation, credit
 * redemption, HTTP transport, and session management.
 */

import { z } from "zod";
import { Payments, EnvironmentName } from "@nevermined-io/payments";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

// ─── Register a Tool (1 credit) ─────────────────────────────────

payments.mcp.registerTool(
  "search",
  {
    title: "Search",
    description: "Search the web for information",
    inputSchema: z.object({ query: z.string() }) as any,
  },
  async (args: any) => ({
    content: [{ type: "text" as const, text: `Results for: ${args.query}` }],
  }),
  { credits: 1n },
);

// ─── Register a Tool with Dynamic Credits ───────────────────────

payments.mcp.registerTool(
  "summarize",
  {
    title: "Summarize",
    description: "Summarize text. Price scales with output length.",
    inputSchema: z.object({ text: z.string() }) as any,
  },
  async (args: any) => ({
    content: [
      {
        type: "text" as const,
        text: `Summary of ${args.text.length} chars...`,
      },
    ],
  }),
  {
    // Dynamic: callable receives context AFTER tool executes
    credits: (ctx: any) => {
      const text = ctx.result?.content?.[0]?.text || "";
      return BigInt(
        text.length < 500 ? 2 : Math.min(10, 2 + Math.floor(text.length / 500)),
      );
    },
  },
);

// ─── Register a Resource (5 credits) ────────────────────────────

payments.mcp.registerResource(
  "Latest Report",
  "data://reports/latest",
  {
    title: "Latest Report",
    description: "Get the latest analysis report",
    mimeType: "application/json",
  },
  async () => ({
    contents: [
      {
        uri: "data://reports/latest",
        text: '{"status": "ok"}',
        mimeType: "application/json",
      },
    ],
  }),
  { credits: 5n },
);

// ─── Register a Prompt (1 credit) ───────────────────────────────

payments.mcp.registerPrompt(
  "analyze",
  {
    title: "Analyze Topic",
    description: "Generate an analysis prompt",
    argsSchema: z.object({ topic: z.string() }) as any,
  },
  (args: any) => ({
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: `Analyze: ${args.topic}` },
      },
    ],
  }),
  { credits: 1n },
);

// ─── Start the server ───────────────────────────────────────────
// One line for the full server: /mcp, OAuth, health, CORS, SSE

async function main() {
  const { info } = await payments.mcp.start({
    port: 3000,
    agentId: process.env.NVM_AGENT_ID!,
    baseUrl: "http://localhost:3000",
    serverName: "my-mcp-server",
    version: "1.0.0",
    description: "Paid search and analysis tools",
  });

  console.log(`MCP server running at ${info.baseUrl}/mcp`);
  console.log("Tools: search (1 credit), summarize (2-10 credits)");
  console.log("Resources: data://reports/latest (5 credits)");
  console.log("Prompts: analyze (1 credit)");
}

main().catch(console.error);
