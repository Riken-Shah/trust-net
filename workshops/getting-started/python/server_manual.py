"""
Nevermined Lab: Getting Started — Manual Payment Verification (No Middleware)

The 3-step flow: verify → execute → settle
Use this when you need full control over the payment flow.
"""

import base64
import os

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from payments_py import Payments, PaymentOptions
from payments_py.x402.helpers import build_payment_required

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

PLAN_ID = os.getenv("NVM_PLAN_ID", "")
AGENT_ID = os.getenv("NVM_AGENT_ID", "")

app = FastAPI()


class AskRequest(BaseModel):
    query: str


@app.post("/ask")
async def ask(request: Request, body: AskRequest):
    # Build the payment specification for this endpoint
    payment_required = build_payment_required(
        plan_id=PLAN_ID,
        endpoint=str(request.url),
        agent_id=AGENT_ID,
        http_verb=request.method,
    )

    # Check for token in the payment-signature header
    token = request.headers.get("payment-signature")

    if not token:
        # No token → return 402 with payment requirements
        encoded = base64.b64encode(
            payment_required.model_dump_json(by_alias=True).encode()
        ).decode()
        return JSONResponse(
            status_code=402,
            content={"error": "Payment Required"},
            headers={"payment-required": encoded},
        )

    # Step 1: Verify (does NOT burn credits)
    verification = payments.facilitator.verify_permissions(
        payment_required=payment_required,
        x402_access_token=token,
        max_amount="1",
    )

    if not verification.is_valid:
        return JSONResponse(
            status_code=402,
            content={"error": verification.invalid_reason},
        )

    # Step 2: Execute your logic
    result = f"Result for: {body.query}"

    # Step 3: Settle (burns credits)
    payments.facilitator.settle_permissions(
        payment_required=payment_required,
        x402_access_token=token,
        max_amount="1",
    )

    return {"answer": result}


if __name__ == "__main__":
    print("Server (manual verification) running on http://localhost:3000")
    uvicorn.run(app, host="0.0.0.0", port=3000)
