/**
 * Nevermined Lab: Getting Started — Protected Server
 *
 * Express server with x402 payment middleware.
 * The middleware handles 402 responses, token verification, and credit settlement.
 */

import express from "express";
import { Payments, EnvironmentName } from "@nevermined-io/payments";
import { paymentMiddleware } from "@nevermined-io/payments/express";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

const PLAN_ID = process.env.NVM_PLAN_ID!;

const app = express();
app.use(express.json());

// One line to protect your endpoint
app.use(
  paymentMiddleware(payments, {
    "POST /ask": { planId: PLAN_ID, credits: 1 },
  }) as express.RequestHandler,
);

// This handler only runs if payment is valid
app.post("/ask", async (req, res) => {
  const { query } = req.body;
  res.json({ answer: `Result for: ${query}` });
});

app.listen(3000, () => {
  console.log("Protected server running on http://localhost:3000");
  console.log(`Plan ID: ${PLAN_ID}`);
});
