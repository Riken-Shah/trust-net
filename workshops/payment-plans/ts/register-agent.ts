/**
 * Nevermined Lab: Payment Plans — Register Agent + Plan
 *
 * Complete registration: create an agent and attach a payment plan
 * in a single call.
 */

import { Payments, EnvironmentName } from "@nevermined-io/payments";
import type {
  AgentMetadata,
  AgentAPIAttributes,
  PlanMetadata,
} from "@nevermined-io/payments";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

async function main() {
  // Credits config: 100 fixed credits, 1 per request
  const creditsConfig = payments.plans.getFixedCreditsConfig(100n, 1n);

  // Price config: $10 via Stripe
  const priceConfig = payments.plans.getFiatPriceConfig(
    1000n,
    payments.getAccountAddress() as `0x${string}`,
  );

  // Register agent + plan in one call
  const result = await payments.agents.registerAgentAndPlan(
    {
      name: "My AI Agent",
      description: "AI analysis service",
    } as AgentMetadata,
    {
      endpoints: [{ POST: "https://your-server.com/ask" }],
    } as AgentAPIAttributes,
    {
      name: "Pro Plan",
      description: "100 credits for $10",
    } as PlanMetadata,
    priceConfig,
    creditsConfig,
  );

  console.log(`Agent ID: ${result.agentId}`); // did:nv:...
  console.log(`Plan ID:  ${result.planId}`); // did:nv:...
}

main().catch(console.error);
