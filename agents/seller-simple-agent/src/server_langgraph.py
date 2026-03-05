"""
FastAPI server wrapping the LangGraph agent for local development.

Thin HTTP wrapper around the LangGraph ReAct agent. Payment protection is
handled entirely by @requires_payment on the tools — no FastAPI middleware.

Usage:
    poetry run agent-langgraph
"""

import base64
import os
import sys

from dotenv import load_dotenv

load_dotenv()

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from payments_py.x402.helpers import build_payment_required

from .analytics import analytics
from .langgraph_agent import NVM_AGENT_ID, NVM_PLAN_ID, create_agent, run_agent
from .pricing import PRICING_TIERS

PORT = int(os.getenv("PORT", "3000"))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

if not OPENAI_API_KEY:
    print("OPENAI_API_KEY is required. Set it in .env file.")
    sys.exit(1)

graph = create_agent()

app = FastAPI(
    title="Kit B - Data Selling Agent (LangGraph)",
    description="LangGraph ReAct agent with x402 payment-protected data tools",
)


class DataRequest(BaseModel):
    query: str


@app.post("/data")
async def data(request: Request, body: DataRequest) -> JSONResponse:
    """Query data through the LangGraph agent.

    Payment is handled by @requires_payment on each tool. If no valid
    token is provided, the tool raises PaymentRequiredError which we
    translate into an HTTP 402 response with the standard headers.
    """
    try:
        payment_token = request.headers.get("payment-signature", "")
        if not payment_token:
            pr = build_payment_required(
                plan_id=NVM_PLAN_ID,
                endpoint="/data",
                agent_id=NVM_AGENT_ID,
                http_verb="POST",
            )
            pr_b64 = base64.b64encode(
                pr.model_dump_json(by_alias=True).encode()
            ).decode()
            return JSONResponse(
                status_code=402,
                content={"error": "Payment Required"},
                headers={"payment-required": pr_b64},
            )

        response = run_agent(graph, body.query, payment_token)

        return JSONResponse(content={
            "response": response,
        })

    except Exception as error:
        print(f"Error in /data: {error}")
        return JSONResponse(
            status_code=500,
            content={"error": str(error)},
        )


@app.get("/pricing")
async def pricing() -> JSONResponse:
    """Get pricing information (unprotected)."""
    return JSONResponse(content={
        "planId": NVM_PLAN_ID,
        "tiers": PRICING_TIERS,
    })


@app.get("/stats")
async def stats() -> JSONResponse:
    """Get usage statistics (unprotected)."""
    return JSONResponse(content=analytics.get_stats())


@app.get("/health")
async def health() -> JSONResponse:
    """Health check endpoint (unprotected)."""
    return JSONResponse(content={"status": "ok"})


def main():
    """Run the FastAPI server."""
    print(f"Data Selling Agent (LangGraph) running on http://localhost:{PORT}")
    print("\nPayment protection via @requires_payment on LangGraph tools")
    print(f"Plan ID: {NVM_PLAN_ID}")
    print("\nEndpoints:")
    print("  POST /data     - Query data (send x402 token in 'payment-signature' header)")
    print("  GET  /pricing  - View pricing tiers")
    print("  GET  /stats    - View usage analytics")
    print("  GET  /health   - Health check")

    uvicorn.run(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
