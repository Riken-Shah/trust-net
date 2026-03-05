"""
Nevermined Lab: Payment Plans — All Plan Types

Five ways to price your AI agent:
1. Fixed Credits     — Same cost per request
2. Dynamic Credits   — Variable cost per request
3. Time-Based        — Unlimited access for a duration
4. Pay-As-You-Go     — USDC per request, no prepurchase
5. Free Trial        — Limited free credits for onboarding
"""

import os
import urllib3
from dotenv import load_dotenv
from payments_py import Payments, PaymentOptions

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv()

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

# ─── 1. Fixed Credits ────────────────────────────────────────────
# 100 credits total, 1 credit per request. Simple and predictable.
fixed_credits = payments.plans.get_fixed_credits_config(
    credits_granted=100,
    credits_per_request=1,
)

# ─── 2. Dynamic Credits ─────────────────────────────────────────
# 100 credits total, 1-10 credits per request depending on complexity.
dynamic_credits = payments.plans.get_dynamic_credits_config(
    credits_granted=100,
    min_credits_per_request=1,
    max_credits_per_request=10,
)

# ─── 3. Time-Based (Expirable) ──────────────────────────────────
# Unlimited access for 30 days.
ONE_MONTH = 30 * 24 * 60 * 60  # 2,592,000 seconds
time_based = payments.plans.get_expirable_duration_config(
    duration_of_plan=ONE_MONTH,
)

# ─── 4. Pay-As-You-Go ───────────────────────────────────────────
# No prepurchased credits. Settle in USDC per request.
pay_as_you_go = payments.plans.get_pay_as_you_go_credits_config()

# ─── 5. Free Trial ──────────────────────────────────────────────
# 10 free credits, 1 per request. Set price to 0 when creating the plan.
free_trial = payments.plans.get_fixed_credits_config(
    credits_granted=10,
    credits_per_request=1,
)
# When registering: set price amount to 0 and is_trial_plan=True

# ─── Price Configurations ────────────────────────────────────────

builder_address = payments.account_address
USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"  # USDC on Base Sepolia

# Crypto: price in USDC (6 decimals → $10 = 10_000_000)
crypto_price = payments.plans.get_crypto_price_config(
    10_000_000,      # $10 USDC
    builder_address,
    USDC_ADDRESS,
)

# Fiat: price in cents via Stripe ($10.00 = 1000 cents)
fiat_price = payments.plans.get_fiat_price_config(
    1000,            # $10.00
    builder_address,
)

print("All plan types configured successfully")
