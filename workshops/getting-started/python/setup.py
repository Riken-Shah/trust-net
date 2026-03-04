"""
Nevermined Lab: Getting Started — SDK Initialization

Initialize the Nevermined Payments SDK and verify connection.
The Payments object is your gateway to everything.
"""

import os
from payments_py import Payments, PaymentOptions

# Initialize with your API key and environment
# Sandbox keys start with "sandbox:", live keys with "live:"
payments = Payments.get_instance(
    PaymentOptions(
        nvm_api_key=os.getenv("NVM_API_KEY", ""),
        environment=os.getenv("NVM_ENVIRONMENT", "sandbox"),
    )
)

# Verify the connection
print("Connected as:", payments.account_address)

# The Payments object exposes these sub-modules:
#
#   payments.plans          → Create and manage payment plans
#   payments.agents         → Register and manage agents
#   payments.x402           → Generate access tokens (subscriber)
#   payments.facilitator    → Verify and settle (runtime)
#   payments.mcp            → MCP server integration
#   payments.a2a            → Agent-to-Agent protocol support
#   payments.observability  → LLM cost tracking (Helicone)
