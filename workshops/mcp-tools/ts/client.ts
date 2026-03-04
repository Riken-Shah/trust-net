/**
 * Nevermined Lab: MCP — Client
 *
 * Call monetized MCP tools using x402 tokens.
 * The response includes tool output + payment metadata (_meta).
 */

import { Payments, EnvironmentName } from "@nevermined-io/payments";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!, // subscriber key
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

const PLAN_ID = process.env.NVM_PLAN_ID!;
const SERVER_URL = "http://localhost:3000";

async function main() {
  // 1. Get x402 access token
  const { accessToken } = await payments.x402.getX402AccessToken(PLAN_ID);

  // 2. Call MCP tool via JSON-RPC
  const response = await fetch(`${SERVER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "search",
        arguments: { query: "climate data" },
      },
      id: 1,
    }),
  });

  const result = await response.json();

  // Tool output
  console.log("Content:", result.result?.content);

  // Payment metadata: tx hash, credits redeemed, plan ID, etc.
  console.log("Payment:", result.result?._meta);
}

main().catch(console.error);
