# Workshop: Nevermined x A2A — Agent-to-Agent Payments

**Duration:** 45-60 minutes
**Goal:** Participants build a seller agent with an Agent Card and payment extension, then build a buyer agent that discovers the seller, subscribes, and sends paid messages via the A2A protocol.

---

## Format Recommendation

| Element | Recommendation |
|---------|----------------|
| **Slides** | Minimal — use diagrams for the A2A flow |
| **Live demo** | Primary format — run seller + buyer side by side |
| **Terminal** | Three terminals: seller, buyer, and curl for Agent Card inspection |
| **Browser** | nevermined.app for balance tracking |

**Why live demo:** A2A is about two agents talking to each other. Seeing seller and buyer running simultaneously is far more impactful than slides.

---

## Pre-Workshop Checklist

### Your machine (presenter)

- [ ] `payments-py` installed with A2A support (`pip install payments-py`)
- [ ] Two Nevermined accounts:
  - **Builder account**: `NVM_API_KEY` for the seller
  - **Subscriber account**: separate `NVM_API_KEY` for the buyer
- [ ] `NVM_PLAN_ID` and `NVM_AGENT_ID` set (registered via app or SDK)
- [ ] All workshop files tested: seller starts, buyer discovers and communicates
- [ ] Port 8000 free for the seller agent

### Participant machines

- [ ] Python 3.10+ or Node.js 18+
- [ ] Two Nevermined sandbox accounts (or pair up: one builds seller, partner builds buyer)

---

## Agenda

| Time | Section | Format | Files |
|------|---------|--------|-------|
| 0:00 - 0:05 | What is A2A + why payments? | Slides | — |
| 0:05 - 0:10 | A2A architecture with Nevermined | Diagram | — |
| 0:10 - 0:25 | Building the seller agent | Live code | `seller.py` / `seller.ts` |
| 0:25 - 0:40 | Building the buyer agent | Live code | `buyer.py` / `buyer.ts` |
| 0:40 - 0:55 | Running both + end-to-end demo | Live demo | — |
| 0:55 - 1:00 | Q&A | Open | — |

---

## Detailed Script

### Section 1: What is A2A (5 min)

**Key talking points:**

> "A2A is Google's open protocol for multi-agent systems. JSON-RPC for messaging, SSE for streaming, Agent Cards for discovery. What it doesn't have is payments — that's where Nevermined comes in."

> "With Nevermined, your Agent Card advertises both what your agent can do AND how much it costs. Payment validation happens at the message level, credits settle at task completion."

---

### Section 2: Architecture (5 min)

Draw or show this architecture:

```
Buyer Agent                        Seller Agent
    |                                   |
    |  1. GET /.well-known/agent.json   |
    |---------------------------------->|  (Agent Card + payment extension)
    |                                   |
    |  2. order_plan(planId)            |
    |         (to Nevermined)           |
    |                                   |
    |  3. JSON-RPC message              |
    |  + payment-signature header       |
    |---------------------------------->|
    |                                   |  PaymentsRequestHandler:
    |                                   |  → verify x402 token
    |                                   |  → call executor
    |                                   |  → settle credits
    |  4. SSE events                    |
    |<----------------------------------|  (final event: creditsUsed)
```

**Key difference from HTTP:**
- HTTP: payment per request, middleware on endpoints
- A2A: payment per message, settlement per task, tools are plain functions

---

### Section 3: Building the Seller (15 min)

**Open `python/seller.py`**

Walk through the two parts:

#### Part 1: The Agent Card

```python
agent_card = build_payment_agent_card(
    base_card={"name": "Data Seller", "url": f"http://localhost:{PORT}", ...},
    payment_metadata={
        "paymentType": "dynamic",
        "credits": 1,
        "planId": PLAN_ID,
        "agentId": AGENT_ID,
    },
)
```

> "The Agent Card is your storefront. Buyers discover it at `/.well-known/agent.json` — it advertises what your agent does (skills) and what it costs (payment extension)."

#### Part 2: The Agent Function

```python
@a2a_requires_payment(
    payments=payments,
    agent_card=agent_card,
    default_credits=1,
)
async def my_agent(context) -> AgentResponse:
    text = context.get_user_input()
    tool = "research" if "research" in text.lower() else "search"
    credits_used = CREDIT_MAP.get(tool, 1)
    result = f"[{tool}] Result for: {text}"
    return AgentResponse(text=result, credits_used=credits_used)

my_agent.serve(port=PORT)
```

> "The decorator handles everything: token validation, 402 responses, credit settlement. You just write your logic and return an `AgentResponse` with the text and how many credits it cost."

> "Notice there's no Executor class, no event queue, no handler. The decorator abstracts all of that. You return `credits_used` in the response — the decorator settles them on-chain."

**Show TypeScript equivalent (`ts/seller.ts`):**
- Uses `payments.a2a.start(...)` with an executor object
- Executor has `execute(context, eventBus)` — publishes status events
- Final event includes `metadata: { creditsUsed: 5 }` for settlement

---

### Section 4: Building the Buyer (15 min)

**Open `python/buyer.py`**

Walk through the steps:

1. **Discover**: `GET /.well-known/agent-card.json`
   ```python
   card = httpx.get(f"{SELLER_URL}/.well-known/agent-card.json").json()
   ```

2. **Parse payment extension**: Extract `planId` and `agentId`
   ```python
   extensions = card.get("capabilities", {}).get("extensions", [])
   payment_ext = next(
       (ext["params"] for ext in extensions if ext.get("uri") == "urn:nevermined:payment"),
       None,
   )
   plan_id = payment_ext["planId"]
   ```

3. **Subscribe** (if needed): `payments.plans.order_plan(plan_id)`

4. **Send paid message** (PaymentsClient handles x402 tokens internally):
   ```python
   from a2a.types import MessageSendParams, Message, TextPart

   client = PaymentsClient(
       agent_base_url=SELLER_URL, payments=payments,
       agent_id=agent_id, plan_id=plan_id,
   )

   params = MessageSendParams(
       message=Message(
           message_id=str(uuid4()), role="user",
           parts=[TextPart(text="Search for climate data")],
       )
   )

   async for event in client.send_message_stream(params):
       task, status_event = event  # tuple: (Task, TaskStatusUpdateEvent)
       if task.status.state == "completed":
           print(f"Credits used: {task.metadata.get('creditsUsed')}")
   ```

> "PaymentsClient handles x402 tokens internally — you don't call `get_x402_access_token` yourself. And `send_message_stream` takes a `MessageSendParams` object, not a plain string."

**Show TypeScript equivalent (`ts/buyer.ts`):**
- Uses `payments.a2a.getClient(...)` to create the A2A client
- Supports both `sendA2AMessage` (single response) and `sendA2AMessageStream` (SSE)

---

### Section 5: Running Both (15 min)

**Terminal 1 — Start the seller:**
```bash
python seller.py
# → Seller running on http://localhost:8000
# → Agent Card: http://localhost:8000/.well-known/agent.json
```

**Inspect the Agent Card:**
```bash
curl http://localhost:8000/.well-known/agent.json | python -m json.tool
```

> "See the payment extension? `planId`, `agentId`, `defaultCredits`. This is what the buyer discovers automatically."

**Terminal 2 — Run the buyer:**
```bash
python buyer.py
# → Discovered: Data Seller
# → Plan: did:nv:...
# → Event: ...
# → Credits used: 1
```

**Show in nevermined.app:**
- Buyer's credit balance decreased
- Transaction recorded in agent analytics

> "Two independent agents, talking to each other, with automatic payment. The seller doesn't need to know who the buyer is. The buyer doesn't need to know the pricing in advance. Discovery + payment, fully automated."

---

## Troubleshooting Notes (for presenter)

| Issue | Fix |
|-------|-----|
| Agent Card returns 404 | Check server is running; check URL includes correct path |
| `extensions` key missing | Check `build_payment_agent_card` includes plan_id and agent_id |
| Token verification fails | Buyer must use a subscriber key, not a builder key |
| `send_message_stream` hangs | Check seller's executor emits a `final: True` event |
| Credits not settling | Check `creditsUsed` is in the final event's metadata (as string in Python) |
| Port 8000 in use | Change `PORT` variable or kill existing process |

---

## Backup Plan

If the live two-agent demo fails:
1. **Walk through the code** — open seller.py and buyer.py side by side, explain the flow
2. **Use curl to simulate** — manually send JSON-RPC messages to the seller
3. **Focus on the Agent Card** — show the discovery pattern even without a running buyer
