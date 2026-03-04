"""
Nevermined Lab: MCP — Client

Call monetized MCP tools using x402 tokens.
The response includes tool output + payment metadata (_meta).
"""

import os
import httpx
from payments_py import Payments, PaymentOptions

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),  # subscriber key
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

PLAN_ID = os.getenv("NVM_PLAN_ID", "")
SERVER_URL = "http://localhost:3000"


def main():
    # 1. Get x402 access token
    token_result = payments.x402.get_x402_access_token(PLAN_ID)
    access_token = token_result["accessToken"]

    # 2. Call MCP tool via JSON-RPC
    with httpx.Client() as client:
        response = client.post(
            f"{SERVER_URL}/mcp",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {access_token}",
            },
            json={
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {
                    "name": "search",
                    "arguments": {"query": "climate data"},
                },
                "id": 1,
            },
        )

    result = response.json()

    # Tool output
    print("Content:", result.get("result", {}).get("content"))

    # Payment metadata: tx hash, credits redeemed, plan ID, etc.
    print("Payment:", result.get("result", {}).get("_meta"))


if __name__ == "__main__":
    main()
