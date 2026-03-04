/**
 * Nevermined Lab: Getting Started — x402 Client Flow
 *
 * Demonstrates the complete x402 payment protocol:
 * 1. Request without token  → 402 Payment Required
 * 2. Get x402 access token  → From Nevermined
 * 3. Request with token     → 200 OK
 */

import { Payments, EnvironmentName } from "@nevermined-io/payments";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

const SERVER_URL = "http://localhost:3000";
const PLAN_ID = process.env.NVM_PLAN_ID!;

async function main() {
  // Step 1: Request without token → 402
  const res1 = await fetch(`${SERVER_URL}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "What is AI?" }),
  });

  console.log(`Step 1: ${res1.status}`); // 402 Payment Required

  // Step 2: Get x402 access token
  const { accessToken } = await payments.x402.getX402AccessToken(PLAN_ID);
  console.log(`Step 2: Token obtained (${accessToken.length} chars)`);

  // Step 3: Request with token → 200
  const res2 = await fetch(`${SERVER_URL}/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "payment-signature": accessToken,
    },
    body: JSON.stringify({ query: "What is AI?" }),
  });

  const data = await res2.json();
  console.log(`Step 3: ${res2.status}`, data); // 200 OK
}

main().catch(console.error);
