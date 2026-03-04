"""
Nevermined Lab: A2A — Seller Agent

A2A seller with:
- Agent Card with payment extension (discovery)
- Executor pattern (business logic)
- Credit map per tool (dynamic settlement)
- Credits settle per task completion, not per tool call
"""

import os
from payments_py import Payments, PaymentOptions
from payments_py.a2a import PaymentsRequestHandler, build_payment_agent_card

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


# ─── Executor: your business logic ──────────────────────────────
#
# IMPORTANT: The PaymentsRequestHandler validates the x402 token
# from the `payment-signature` header BEFORE calling your executor.
# If the token is missing or invalid, execute() is never called.
#
# As a developer, you only need to worry about two things:
# 1. Your business logic inside execute()
# 2. Reporting `creditsUsed` in the final event metadata
#
# The handler takes care of everything else: token verification,
# 402 responses, and credit settlement on task completion.


class MyExecutor:
    async def execute(self, context, event_queue):
        query = context.message.parts[0].text

        # Determine which tool to use and its cost
        tool = "research" if "research" in query.lower() else "search"
        credits_used = CREDIT_MAP.get(tool, 1)

        # Process the request (your actual logic here)
        result = f"[{tool}] Result for: {query}"

        # Emit final event with creditsUsed — triggers settlement
        await event_queue.enqueue_event(
            {
                "status": {"state": "completed"},
                "final": True,
                "metadata": {"creditsUsed": str(credits_used)},
            }
        )


# ─── Agent Card with payment extension ──────────────────────────

agent_card = build_payment_agent_card(
    base_card={
        "name": "Data Seller",
        "url": f"http://localhost:{PORT}",
        "description": "Search and research agent with paid access",
        "skills": [
            {"id": "search", "name": "Search", "description": "Quick search (1 credit)"},
            {"id": "research", "name": "Research", "description": "Deep research (10 credits)"},
        ],
    },
    plan_id=PLAN_ID,
    agent_id=AGENT_ID,
    default_credits=1,
)


# ─── Start the A2A server ───────────────────────────────────────

handler = PaymentsRequestHandler(payments, agent_card, 1, MyExecutor())

print(f"Seller running on http://localhost:{PORT}")
print(f"Agent Card: http://localhost:{PORT}/.well-known/agent.json")
