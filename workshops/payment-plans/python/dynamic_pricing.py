"""
Nevermined Lab: Payment Plans — Dynamic Pricing Server

Charge different amounts per request based on complexity.
The credits parameter accepts a function instead of a fixed number.
"""

import os
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from payments_py import Payments, PaymentOptions
from payments_py.x402.fastapi import PaymentMiddleware
from dotenv import load_dotenv
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv()

payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

PLAN_ID = os.getenv("NVM_PLAN_ID", "")

app = FastAPI()


class GenerateRequest(BaseModel):
    prompt: str


# Dynamic credits: charge based on request complexity
app.add_middleware(
    PaymentMiddleware,
    payments=payments,
    routes={
        "POST /generate": {
            "plan_id": PLAN_ID,
            # Function receives the request — decide cost at settlement time
            "credits": lambda req: max(1, len(req.body.get("prompt", "")) // 500),
        }
    },
)


@app.post("/generate")
async def generate(body: GenerateRequest):
    credits_charged = max(1, len(body.prompt) // 500)
    return {
        "result": f"Generated response for: {body.prompt}",
        "credits_charged": credits_charged,
    }


if __name__ == "__main__":
    print("Dynamic pricing server on http://localhost:3000")
    uvicorn.run(app, host="0.0.0.0", port=3000)
