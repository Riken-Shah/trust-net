"""
Nevermined Lab: A2A — Seller Agent

A2A seller with:
- Agent Card with payment extension (discovery)
- @a2a_requires_payment decorator (handles verify + settle)
- Dynamic credits per request
"""

import os
from payments_py import Payments, PaymentOptions
from payments_py.a2a import AgentResponse, a2a_requires_payment, build_payment_agent_card

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

PLAN_ID = os.getenv("NVM_PLAN_ID", "")
AGENT_ID = os.getenv("NVM_AGENT_ID", "")
PORT = 8000

# Credit cost per tool
CREDIT_MAP = {"search": 1, "summarize": 5, "research": 10}


# ─── Agent Card with payment extension ──────────────────────────
#
# The Agent Card is your storefront. Buyers discover it at
# /.well-known/agent.json — it advertises what your agent does
# (skills) and what it costs (payment extension).

agent_card = build_payment_agent_card(
    base_card={
        "name": "Data Seller",
        "url": f"http://localhost:{PORT}",
        "version": "1.0.0",
        "description": "Search and research agent with paid access",
        "capabilities": {"streaming": True},
        "defaultInputModes": ["text"],
        "defaultOutputModes": ["text"],
        "skills": [
            {"id": "search", "name": "Search", "description": "Quick search (1 credit)"},
            {"id": "research", "name": "Research", "description": "Deep research (10 credits)"},
        ],
    },
    payment_metadata={
        "paymentType": "dynamic",
        "credits": 1,
        "planId": PLAN_ID,
        "agentId": AGENT_ID,
    },
)


# ─── Agent function with payment protection ─────────────────────
#
# The @a2a_requires_payment decorator handles everything:
# - Validates x402 tokens before calling your function
# - Returns 402 if the token is missing or invalid
# - Settles credits on completion based on credits_used
#
# You only worry about your logic and returning an AgentResponse.


@a2a_requires_payment(
    payments=payments,
    agent_card=agent_card,
    default_credits=1,
)
async def my_agent(context) -> AgentResponse:
    text = context.get_user_input()

    # Determine which tool to use and its cost
    tool = "research" if "research" in text.lower() else "search"
    credits_used = CREDIT_MAP.get(tool, 1)

    # Process the request (your actual logic here)
    result = f"[{tool}] Result for: {text}"

    return AgentResponse(text=result, credits_used=credits_used)


# ─── Start the A2A server ───────────────────────────────────────

print(f"Seller running on http://localhost:{PORT}")
print(f"Agent Card: http://localhost:{PORT}/.well-known/agent.json")

my_agent.serve(port=PORT)
