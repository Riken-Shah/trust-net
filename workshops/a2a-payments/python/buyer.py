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
import httpx
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
        card_response = await http.get(f"{SELLER_URL}/.well-known/agent.json")
        card = card_response.json()
    print(f"Discovered: {card['name']}")

    # 2. Parse payment extension
    payment_ext = card["extensions"][0]["params"]
    plan_id = payment_ext["planId"]
    agent_id = payment_ext["agentId"]
    print(f"Plan: {plan_id}")

    # 3. Subscribe to plan (if needed)
    balance = payments.plans.get_plan_balance(plan_id)
    if balance == 0:
        payments.plans.order_plan(plan_id)
        print("Subscribed to plan")

    # 4. Get x402 token
    token = payments.x402.get_x402_access_token(plan_id, agent_id)

    # 5. Send paid message
    client = PaymentsClient(
        url=SELLER_URL,
        payments=payments,
        agent_id=agent_id,
        plan_id=plan_id,
    )

    async for event in client.send_message_stream("Search for climate data"):
        print(f"Event: {event}")
        if event.status.state == "completed":
            print(f"Credits used: {event.metadata.get('creditsUsed')}")
            break


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
