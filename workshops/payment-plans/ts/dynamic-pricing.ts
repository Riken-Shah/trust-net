/**
 * Nevermined Lab: Payment Plans — Dynamic Pricing Server
 *
 * Charge different amounts per request based on complexity.
 * The credits parameter accepts a function instead of a fixed number.
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

// Dynamic credits: charge based on request complexity
app.use(
  paymentMiddleware(payments, {
    "POST /generate": {
      planId: PLAN_ID,
      // Function receives (req, res) — decide cost at settlement time
      credits: (req: any) => {
        const prompt = req.body?.prompt || "";
        // 1 credit per 500 chars, minimum 1
        return Math.max(1, Math.ceil(prompt.length / 500));
      },
    },
  }) as express.RequestHandler,
);

app.post("/generate", async (req, res) => {
  const { prompt } = req.body;
  const creditsCharged = Math.max(1, Math.ceil((prompt || "").length / 500));
  res.json({
    result: `Generated response for: ${prompt}`,
    creditsCharged,
  });
});

app.listen(3000, () => {
  console.log("Dynamic pricing server on http://localhost:3000");
});
