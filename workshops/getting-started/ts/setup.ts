/**
 * Nevermined Lab: Getting Started — SDK Initialization
 *
 * Initialize the Nevermined Payments SDK and verify connection.
 * The Payments object is your gateway to everything.
 */

import { Payments, EnvironmentName } from "@nevermined-io/payments";

// Initialize with your API key and environment
// Sandbox keys start with "sandbox:", live keys with "live:"
const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

// Verify the connection
console.log("Connected as:", payments.getAccountAddress());

/**
 * The Payments object exposes these sub-modules:
 *
 *   payments.plans          → Create and manage payment plans
 *   payments.agents         → Register and manage agents
 *   payments.x402           → Generate access tokens (subscriber)
 *   payments.facilitator    → Verify and settle (runtime)
 *   payments.mcp            → MCP server integration
 *   payments.a2a            → Agent-to-Agent protocol support
 *   payments.observability  → LLM cost tracking (Helicone)
 */
