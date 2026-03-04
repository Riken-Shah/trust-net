/**
 * Nevermined Lab: Payment Plans — All Plan Types
 *
 * Five ways to price your AI agent:
 * 1. Fixed Credits     — Same cost per request
 * 2. Dynamic Credits   — Variable cost per request
 * 3. Time-Based        — Unlimited access for a duration
 * 4. Pay-As-You-Go     — USDC per request, no prepurchase
 * 5. Free Trial        — Limited free credits for onboarding
 */

import { Payments, EnvironmentName } from "@nevermined-io/payments";

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || "sandbox") as EnvironmentName,
});

// ─── 1. Fixed Credits ────────────────────────────────────────────
// 100 credits total, 1 credit per request. Simple and predictable.
const fixedCredits = payments.plans.getFixedCreditsConfig(100n, 1n);

// ─── 2. Dynamic Credits ─────────────────────────────────────────
// 100 credits total, 1-10 credits per request depending on complexity.
const dynamicCredits = payments.plans.getDynamicCreditsConfig(100n, 1n, 10n);

// ─── 3. Time-Based (Expirable) ──────────────────────────────────
// Unlimited access for 30 days.
const ONE_MONTH = 30 * 24 * 60 * 60; // 2,592,000 seconds
const timeBased = payments.plans.getExpirableDurationConfig(BigInt(ONE_MONTH));

// ─── 4. Pay-As-You-Go ───────────────────────────────────────────
// No prepurchased credits. Settle in USDC per request.
const payAsYouGo = payments.plans.getPayAsYouGoCreditsConfig();

// ─── 5. Free Trial ──────────────────────────────────────────────
// 10 free credits, 1 per request. Set price to 0 when creating the plan.
const freeTrial = payments.plans.getFixedCreditsConfig(10n, 1n);
// When registering: set price amount to 0 and isTrialPlan: true

// ─── Price Configurations ────────────────────────────────────────

// Crypto: price in USDC (6 decimals → $10 = 10_000_000)
const cryptoPrice = payments.plans.getCryptoPriceConfig(
  10_000_000n, // $10 USDC
  "0xYourWalletAddress" as `0x${string}`, // receiver
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`, // USDC on Base Sepolia
);

// Fiat: price in cents via Stripe ($10.00 = 1000 cents)
const fiatPrice = payments.plans.getFiatPriceConfig(
  1000n, // $10.00
  "0xYourWalletAddress" as `0x${string}`, // receiver
);
