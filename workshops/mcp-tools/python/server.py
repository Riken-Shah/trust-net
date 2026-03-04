"""
Nevermined Lab: MCP — Monetized MCP Server

Complete MCP server with paid tools, resources, and prompts.
PaymentsMCP handles everything: OAuth, token validation, credit
redemption, HTTP transport, and session management.
"""

import asyncio
import os
from payments_py import Payments, PaymentOptions
from payments_py.mcp import PaymentsMCP

payments = Payments(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

mcp = PaymentsMCP(
    payments,
    name="my-mcp-server",
    agent_id=os.getenv("NVM_AGENT_ID", ""),
    version="1.0.0",
    description="Paid search and analysis tools",
)


# ─── Tool: fixed credits ─────────────────────────────────────────


@mcp.tool(name="search", description="Search the web for information", credits=1)
async def search(query: str) -> str:
    """Search the web."""
    return f"Results for: {query}"


# ─── Tool: dynamic credits ───────────────────────────────────────


def price_by_length(context: dict) -> int:
    """Charge 2-10 credits based on output length."""
    output = context.get("output", [])
    text = output[0]["text"] if output else ""
    if len(text) < 500:
        return 2
    return min(10, 2 + len(text) // 500)


@mcp.tool(
    name="summarize",
    description="Summarize text. Price scales with output length.",
    credits=price_by_length,
)
async def summarize(text: str) -> str:
    """Summarize a long text."""
    return f"Summary of {len(text)} characters..."


# ─── Resource (5 credits) ────────────────────────────────────────


@mcp.resource(
    "data://reports/latest",
    name="Latest Report",
    description="Get the latest analysis report",
    credits=5,
)
async def latest_report() -> dict:
    """Return the latest report."""
    return {
        "contents": [
            {"uri": "data://reports/latest", "text": '{"status": "ok"}', "mimeType": "application/json"}
        ]
    }


# ─── Prompt (1 credit) ───────────────────────────────────────────


@mcp.prompt(
    name="analyze",
    description="Generate an analysis prompt",
    credits=1,
)
def analyze_prompt(topic: str) -> list:
    """Generate a prompt for analysis."""
    return [{"role": "user", "content": {"type": "text", "text": f"Analyze: {topic}"}}]


# ─── Start the server ────────────────────────────────────────────
# One line for the full server: /mcp, OAuth, health, CORS, SSE


async def main():
    result = await mcp.start(port=3000)
    info = result["info"]
    print(f"MCP server running at {info['baseUrl']}/mcp")
    print("Tools: search (1 credit), summarize (2-10 credits)")
    print("Resources: data://reports/latest (5 credits)")
    print("Prompts: analyze (1 credit)")

    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await result["stop"]()


if __name__ == "__main__":
    asyncio.run(main())
