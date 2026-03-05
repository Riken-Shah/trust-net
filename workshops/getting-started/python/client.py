"""
Nevermined Lab: Getting Started — x402 Client Flow

Demonstrates the complete x402 payment protocol:
1. Request without token  → 402 Payment Required
2. Get x402 access token  → From Nevermined
3. Request with token     → 200 OK
"""

import os
import httpx
import urllib3
from dotenv import load_dotenv

from payments_py import Payments, PaymentOptions

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv()

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_SUBSCRIBER_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

SERVER_URL = "http://localhost:4000"
PLAN_ID = os.getenv("NVM_PLAN_ID", "")


def main():
    with httpx.Client(timeout=30.0) as client:
        # Step 1: Request without token → 402
        res1 = client.post(
            f"{SERVER_URL}/ask",
            json={"query": "What is AI?"},
        )
        print(f"Step 1: {res1.status_code}")  # 402 Payment Required

        # Step 2: Check plan balance
        balance = payments.plans.get_plan_balance(PLAN_ID)
        print(f"Step 2: Plan balance: {balance}")
        if not balance or balance.balance == 0:
            print("No credits — ordering plan...")
            order_result = payments.plans.order_plan(PLAN_ID)
            print(f"Step 2b: Plan ordered — {order_result}")

        # Step 3: Get x402 access token
        token_result = payments.x402.get_x402_access_token(PLAN_ID)
        access_token = token_result["accessToken"]
        print(f"Step 3: Token obtained ({len(access_token)} chars)")

        # Step 4: Request with token → 200
        res2 = client.post(
            f"{SERVER_URL}/ask",
            headers={"payment-signature": access_token},
            json={"query": "What is AI?"},
        )
        if res2.status_code == 200:
            print(f"Step 3: {res2.status_code}", res2.json())
        else:
            print(f"Step 3: {res2.status_code}", res2.text)


if __name__ == "__main__":
    main()
