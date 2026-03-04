/**
 * Nevermined Lab: A2A — Seller Agent
 *
 * A2A seller with:
 * - Agent Card with payment extension (discovery)
 * - Executor pattern (business logic)
 * - Credit map per tool (dynamic settlement)
 * - Credits settle per task completion, not per tool call
 */

import { Payments, EnvironmentName } from "@nevermined-io/payments";
import type {
  AgentCard,
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  TaskStatusUpdateEvent,
} from "@nevermined-io/payments";
import { v4 as uuidv4 } from "uuid";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

const PLAN_ID = process.env.NVM_PLAN_ID!;
const AGENT_ID = process.env.NVM_AGENT_ID!;
const PORT = 8000;

// Credit cost per tool
const CREDIT_MAP: Record<string, number> = {
  search: 1,
  summarize: 5,
  research: 10,
};

// ─── Executor: your business logic ──────────────────────────────
//
// IMPORTANT: The PaymentsRequestHandler validates the x402 token
// from the `payment-signature` header BEFORE calling your executor.
// If the token is missing or invalid, execute() is never called.
//
// As a developer, you only need to worry about two things:
// 1. Your business logic inside execute()
// 2. Reporting `creditsUsed` in the final event metadata
//
// The handler takes care of everything else: token verification,
// 402 responses, and credit settlement on task completion.

class MyExecutor implements AgentExecutor {
  async execute(context: RequestContext, eventBus: ExecutionEventBus) {
    const firstPart = context.userMessage.parts[0];
    const query = firstPart?.kind === "text" ? firstPart.text : "";

    // Determine which tool to use and its cost
    const tool = query.toLowerCase().includes("research")
      ? "research"
      : "search";
    const creditsUsed = CREDIT_MAP[tool] || 1;

    // Process the request (your actual logic here)
    const result = `[${tool}] Result for: ${query}`;

    // Emit final event with creditsUsed — triggers settlement
    const finalEvent: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId: context.taskId,
      contextId: context.contextId,
      status: {
        state: "completed",
        message: {
          kind: "message",
          role: "agent",
          messageId: uuidv4(),
          parts: [{ kind: "text", text: result }],
          taskId: context.taskId,
          contextId: context.contextId,
        },
        timestamp: new Date().toISOString(),
      },
      final: true,
      metadata: { creditsUsed, planId: PLAN_ID },
    };

    eventBus.publish(finalEvent);
    eventBus.finished();
  }

  async cancelTask(taskId: string) {
    console.log(`Cancelling task: ${taskId}`);
  }
}

// ─── Agent Card with payment extension ──────────────────────────

const baseCard: AgentCard = {
  name: "Data Seller",
  description: "Search and research agent with paid access",
  url: `http://localhost:${PORT}/a2a/`,
  version: "1.0.0",
  capabilities: { streaming: true },
  skills: [
    { id: "search", name: "Search", description: "Quick search (1 credit)" },
    {
      id: "research",
      name: "Research",
      description: "Deep research (10 credits)",
    },
  ],
};

// Add Nevermined payment info to the Agent Card
const agentCard = Payments.a2a.buildPaymentAgentCard(baseCard, {
  paymentType: "dynamic",
  credits: 1,
  costDescription: "Search: 1 credit, Summarize: 5, Research: 10",
  planId: PLAN_ID,
  agentId: AGENT_ID,
});

// ─── Start the A2A server ───────────────────────────────────────

async function main() {
  payments.a2a.start({
    agentCard,
    executor: new MyExecutor(),
    port: PORT,
    basePath: "/a2a/",
  });

  console.log(`Seller running on http://localhost:${PORT}/a2a/`);
  console.log(
    `Agent Card: http://localhost:${PORT}/a2a/.well-known/agent.json`,
  );
}

main().catch(console.error);
