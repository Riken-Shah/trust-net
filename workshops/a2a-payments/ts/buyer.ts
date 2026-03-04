/**
 * Nevermined Lab: A2A — Buyer Agent
 *
 * Complete buyer flow:
 * 1. Discover seller via Agent Card
 * 2. Parse payment extension (plan ID, agent ID, pricing)
 * 3. Subscribe to plan
 * 4. Send paid message via A2A client
 * 5. Receive streamed results with credits metadata
 */

import {
  Payments,
  EnvironmentName,
  MessageSendParams,
} from "@nevermined-io/payments";
import { v4 as uuidv4 } from "uuid";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!, // subscriber key
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

const SELLER_URL = "http://localhost:8000/a2a/";

async function main() {
  // 1. Discover seller via Agent Card
  const cardResponse = await fetch(`${SELLER_URL}.well-known/agent.json`);
  const card = await cardResponse.json();
  console.log(`Discovered: ${card.name}`);

  // 2. Parse payment extension
  const paymentExt = card.capabilities?.extensions?.find(
    (ext: any) => ext.uri === "urn:nevermined:payment",
  );
  const planId = paymentExt?.params?.planId;
  const agentId = paymentExt?.params?.agentId;
  console.log(`Plan: ${planId}, Cost: ${paymentExt?.params?.costDescription}`);

  // 3. Subscribe to plan (if needed)
  const balance = await payments.plans.getPlanBalance(planId);
  if (balance.balance.toString() === "0") {
    await payments.plans.orderPlan(planId);
    console.log("Subscribed to plan");
  }

  // 4. Create A2A client (auto-injects x402 tokens)
  const client = await payments.a2a.getClient({
    agentBaseUrl: SELLER_URL,
    agentId,
    planId,
  });

  // 5. Send paid message
  const params: MessageSendParams = {
    message: {
      messageId: uuidv4(),
      role: "user",
      kind: "message",
      parts: [{ kind: "text", text: "Search for climate data" }],
    },
  };

  const response = await client.sendA2AMessage(params);
  console.log("Response:", response);

  // 6. Or use streaming
  const stream = await client.sendA2AMessageStream({
    message: {
      messageId: uuidv4(),
      role: "user",
      kind: "message",
      parts: [{ kind: "text", text: "Research renewable energy trends" }],
    },
  });

  for await (const event of stream) {
    console.log("Event:", event);
    if (event?.result?.status?.final) break;
  }
}

main().catch(console.error);
