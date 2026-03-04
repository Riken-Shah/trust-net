/**
 * Nevermined Lab: Payment Plans — Subscriber Flow
 *
 * The subscriber experience: check balance, buy plan, get token, consume.
 */

import { Payments, EnvironmentName } from "@nevermined-io/payments";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!, // subscriber key
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

const PLAN_ID = process.env.NVM_PLAN_ID!;
const SERVER_URL = "http://localhost:3000";

async function main() {
  // 1. Check balance
  const balance = await payments.plans.getPlanBalance(PLAN_ID);
  console.log(`Credits remaining: ${balance.balance}`);

  // 2. Buy plan if needed
  if (balance.balance.toString() === "0") {
    const order = await payments.plans.orderPlan(PLAN_ID);
    console.log("Plan purchased:", order);
  }

  // 3. Get access token
  const { accessToken } = await payments.x402.getX402AccessToken(PLAN_ID);
  console.log("Token obtained");

  // 4. Use the token
  const response = await fetch(`${SERVER_URL}/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "payment-signature": accessToken,
    },
    body: JSON.stringify({ query: "Analyze this data" }),
  });

  console.log("Response:", await response.json());
}

main().catch(console.error);
