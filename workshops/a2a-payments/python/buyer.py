"""
Nevermined Lab: A2A — Buyer Agent

Complete buyer flow:
1. Discover seller via Agent Card
2. Parse payment extension (plan ID, agent ID, pricing)
3. Subscribe to plan
4. Send paid message via A2A client
5. Receive results with credits metadata
"""

import os
from uuid import uuid4

import httpx
from a2a.types import MessageSendParams, Message, TextPart
from payments_py import Payments, PaymentOptions
from payments_py.a2a import PaymentsClient

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),  # subscriber key
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

SELLER_URL = "http://localhost:8000"


async def main():
    # 1. Discover seller via Agent Card
    async with httpx.AsyncClient() as http:
        card_response = await http.get(f"{SELLER_URL}/.well-known/agent-card.json")
        card = card_response.json()
    print(f"Discovered: {card['name']}")

    # 2. Parse payment extension (find by URI, don't assume position)
    extensions = card.get("capabilities", {}).get("extensions", [])
    payment_ext = next(
        (ext["params"] for ext in extensions if ext.get("uri") == "urn:nevermined:payment"),
        None,
    )
    if not payment_ext:
        raise RuntimeError("Seller has no payment extension in Agent Card")
    plan_id = payment_ext["planId"]
    agent_id = payment_ext["agentId"]
    print(f"Plan: {plan_id}")

    # 3. Subscribe to plan (if needed)
    balance = payments.plans.get_plan_balance(plan_id)
    if balance == 0:
        payments.plans.order_plan(plan_id)
        print("Subscribed to plan")

    # 4. Send paid message (PaymentsClient handles x402 tokens internally)
    client = PaymentsClient(
        agent_base_url=SELLER_URL,
        payments=payments,
        agent_id=agent_id,
        plan_id=plan_id,
    )

    params = MessageSendParams(
        message=Message(
            message_id=str(uuid4()),
            role="user",
            parts=[TextPart(text="Search for climate data")],
        )
    )

    async for event in client.send_message_stream(params):
        # Events arrive as (Task, TaskStatusUpdateEvent) tuples
        task, status_event = event
        state = task.status.state if task.status else None
        print(f"State: {state}")

        if state == "completed":
            # Extract response text
            if task.status.message and task.status.message.parts:
                part = task.status.message.parts[0]
                text = part.root.text if hasattr(part, "root") else str(part)
                print(f"Response: {text}")

            # Extract credits metadata
            metadata = task.metadata or {}
            print(f"Credits used: {metadata.get('creditsUsed')}")
            break


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
