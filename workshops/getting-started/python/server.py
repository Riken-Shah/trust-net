"""
Nevermined Lab: Getting Started — Protected Server

FastAPI server with x402 payment middleware.
The middleware handles 402 responses, token verification, and credit settlement.
"""

import os
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from payments_py import Payments, PaymentOptions
from payments_py.x402.fastapi import PaymentMiddleware

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

PLAN_ID = os.getenv("NVM_PLAN_ID", "")

app = FastAPI()


class AskRequest(BaseModel):
    query: str


# One line to protect your endpoint
app.add_middleware(
    PaymentMiddleware,
    payments=payments,
    routes={"POST /ask": {"plan_id": PLAN_ID, "credits": 1}},
)


# This handler only runs if payment is valid
@app.post("/ask")
async def ask(body: AskRequest):
    return {"answer": f"Result for: {body.query}"}


if __name__ == "__main__":
    print("Protected server running on http://localhost:3000")
    print(f"Plan ID: {PLAN_ID}")
    uvicorn.run(app, host="0.0.0.0", port=3000)
