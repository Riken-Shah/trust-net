"""
Nevermined Lab: Payment Plans — Register Agent + Plan

Complete registration: create an agent and attach a payment plan
in a single call.
"""

import os
from payments_py import Payments, PaymentOptions
from payments_py.common.types import AgentMetadata, AgentAPIAttributes, PlanMetadata

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

# Credits config: 100 fixed credits, 1 per request
credits_config = payments.plans.get_fixed_credits_config(100, 1)

# Price config: $10 via Stripe
price_config = payments.plans.get_fiat_price_config(1000, payments.account_address)

# Register agent + plan in one call
result = payments.agents.register_agent_and_plan(
    agent_metadata=AgentMetadata(
        name="My AI Agent",
        description="AI analysis service",
    ),
    agent_api=AgentAPIAttributes(
        endpoints=[{"POST": "https://your-server.com/ask"}],
    ),
    plan_metadata=PlanMetadata(
        name="Pro Plan",
        description="100 credits for $10",
    ),
    price_config=price_config,
    credits_config=credits_config,
)

print(f"Agent ID: {result['agentId']}")  # did:nv:...
print(f"Plan ID:  {result['planId']}")   # did:nv:...
