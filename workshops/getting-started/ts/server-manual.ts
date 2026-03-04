/**
 * Nevermined Lab: Getting Started — Manual Payment Verification (No Middleware)
 *
 * The 3-step flow: verify → execute → settle
 * Use this when you need full control over the payment flow.
 */

import express from "express";
import {
  Payments,
  EnvironmentName,
  buildPaymentRequired,
} from "@nevermined-io/payments";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

const PLAN_ID = process.env.NVM_PLAN_ID!;
const AGENT_ID = process.env.NVM_AGENT_ID!;

const app = express();
app.use(express.json());

app.post("/ask", async (req, res) => {
  // Build the payment specification for this endpoint
  const paymentRequired = buildPaymentRequired(PLAN_ID, {
    endpoint: req.url,
    agentId: AGENT_ID,
    httpVerb: req.method,
  });

  // Check for token in the payment-signature header
  const token = req.headers["payment-signature"] as string;

  if (!token) {
    // No token → return 402 with payment requirements
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString(
      "base64",
    );
    return res
      .status(402)
      .setHeader("payment-required", encoded)
      .json({ error: "Payment Required" });
  }

  // Step 1: Verify (does NOT burn credits)
  const verification = await payments.facilitator.verifyPermissions({
    paymentRequired,
    x402AccessToken: token,
    maxAmount: 1n,
  });

  if (!verification.isValid) {
    return res.status(402).json({ error: verification.invalidReason });
  }

  // Step 2: Execute your logic
  const { query } = req.body;
  const result = `Result for: ${query}`;

  // Step 3: Settle (burns credits)
  await payments.facilitator.settlePermissions({
    paymentRequired,
    x402AccessToken: token,
    maxAmount: 1n,
  });

  return res.json({ answer: result });
});

app.listen(3000, () => {
  console.log("Server (manual verification) running on http://localhost:3000");
});
