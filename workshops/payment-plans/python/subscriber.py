"""
Nevermined Lab: Payment Plans — Subscriber Flow

The subscriber experience: check balance, buy plan, get token, consume.
"""

import os
import httpx
import urllib3
from payments_py import Payments, PaymentOptions
from dotenv import load_dotenv

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv()

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_SUBSCRIBER_API_KEY", ""),  # subscriber key
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

PLAN_ID = os.getenv("NVM_PLAN_ID", "")
SERVER_URL = "http://localhost:4000"


def main():
    # 1. Check balance
    balance = payments.plans.get_plan_balance(PLAN_ID)
    print(f"Credits remaining: {balance}")

    # 2. Buy plan if needed
    if balance == 0:
        order = payments.plans.order_plan(PLAN_ID)
        print("Plan purchased:", order)

    # 3. Get access token
    token_result = payments.x402.get_x402_access_token(PLAN_ID)
    access_token = token_result["accessToken"]
    print("Token obtained")

    # 4. Use the token
    with httpx.Client(timeout=30.0) as client:
        response = client.post(
            f"{SERVER_URL}/ask",
            headers={"payment-signature": access_token},
            json={"query": "Analyze this data"},
        )
        print("Response:", response.json())


if __name__ == "__main__":
    main()
