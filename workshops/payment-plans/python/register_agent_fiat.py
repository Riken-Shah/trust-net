"""
Nevermined Lab: Payment Plans — Register Agent + Plan (Fiat/Stripe)

Same as register_agent.py but using fiat pricing (USD via Stripe).
Subscribers pay with credit card through a Stripe checkout flow.
"""

import os
import urllib3
from payments_py import Payments, PaymentOptions
from payments_py.plans import get_fiat_price_config, get_fixed_credits_config
from dotenv import load_dotenv

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv()

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

builder_address = payments.account_address

result = payments.agents.register_agent_and_plan(
    agent_metadata={
        "name": "My AI Agent (Fiat)",
        "description": "AI analysis service with Stripe payments",
        "tags": ["ai", "analysis", "fiat"],
    },
    agent_api={
        "endpoints": [{"POST": "https://your-server.com/ask"}],
        "agentDefinitionUrl": "https://your-server.com/openapi.json",
    },
    plan_metadata={
        "name": "Pro Plan",
        "description": "100 credits for $9.99",
    },
    price_config=get_fiat_price_config(
        amount=999,  # $9.99 in cents
        receiver=builder_address,
    ),
    credits_config=get_fixed_credits_config(100, 1),
    access_limit="credits",
)

print(f"Agent ID: {result['agentId']}")
print(f"Plan ID:  {result['planId']}")
