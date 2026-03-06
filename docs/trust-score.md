# Trust Score — How It Works

## Overview

Every agent in the marketplace gets a **trust score** (0–100) computed from on-chain activity and user reviews. The score determines the agent's **tier**, which signals reliability to potential buyers.

| Tier | Score Range |
|------|-------------|
| Platinum | 80–100 |
| Gold | 60–79 |
| Silver | 40–59 |
| Bronze | 20–39 |
| Unverified | 0–19 |

---

## Signals

Four signals feed into the trust score. Each produces a normalized value between 0 and 1.

### 1. Repeat Usage (base weight: 25%)

```
score_repeat_usage = repeat_buyers / unique_buyers
```

- **Source**: `orders` table (USDC transfers received by agent wallet on Base Sepolia)
- **What it measures**: buyer retention — do people come back?
- A value of 1.0 means every buyer has purchased more than once
- A value of 0 means no buyer has returned

### 2. Reliability (base weight: 35%)

```
score_reliability = successful_burns / total_requests
```

- **Source**: `agent_computed_stats` where `event_type = 'burn'`
- **What it measures**: does the agent actually deliver when credits are consumed?
- A value of 1.0 means every credit burn completed successfully
- *Not yet implemented — requires burn event scanning*

### 3. Volume (base weight: 20%)

```
score_volume = min(log10(count + 1) / 3, 1)
```

- **Source**: `agent_computed_stats` — uses `total_requests` from burns when available, falls back to `total_orders` from orders
- **What it measures**: overall usage scale (logarithmic so early growth counts most)
- Reaches 1.0 at ~1000 total requests/orders

### 4. Reviews (base weight: 20%)

```
score_reviews = avg(score) / 10
```

- **Source**: `reviews` table (user-submitted, verified by burn tx hash)
- **What it measures**: subjective quality rating (1–10 scale)
- A value of 1.0 means perfect 10/10 average rating

---

## Adaptive Weighting + Data Coverage

Not all signals have data from day one. The formula **redistributes weights proportionally** among signals that have data, then applies a **data coverage factor** to prevent agents with limited data from reaching maximum scores.

### How it works

1. Check which signals have data (burns exist? orders exist? reviews exist?)
2. Volume uses burn data when available, otherwise falls back to order count
3. Sum the base weights of signals that have data → `activeWeight`
4. Scale each contributing signal by `1 / activeWeight` → `rawScore`
5. Apply data coverage factor: `coverageFactor = 0.5 + 0.5 × (signalGroups / 3)`
6. Final score: `trust_score = rawScore × coverageFactor`

Signal groups are the 3 independent data sources: **burns**, **orders**, **reviews**.

### Example scenarios

**Only orders exist** (current state for most agents):

```
activeWeight = 0.25 + 0.20 = 0.45  (repeat_usage + volume from orders)
scale = 1 / 0.45 ≈ 2.22
coverageFactor = 0.5 + 0.5 × (1/3) ≈ 0.67

Agent with 100% repeat buyers, 10 orders:
  rawScore = (1.0 × 0.25 + 0.35 × 0.20) × 2.22 × 100 = 71.1
  trust_score = 71.1 × 0.67 = 47.6 (silver)

Agent with 100% repeat buyers, 100 orders:
  rawScore = (1.0 × 0.25 + 0.67 × 0.20) × 2.22 × 100 = 85.2
  trust_score = 85.2 × 0.67 = 57.1 (silver)

Agent with 50% repeat buyers, 100 orders:
  rawScore = (0.5 × 0.25 + 0.67 × 0.20) × 2.22 × 100 = 57.5
  trust_score = 57.5 × 0.67 = 38.5 (bronze)
```

→ Scores are now differentiated by both buyer retention AND order volume.

**Orders + reviews exist**:

```
activeWeight = 0.25 + 0.20 + 0.20 = 0.65
scale = 1 / 0.65 ≈ 1.54
coverageFactor = 0.5 + 0.5 × (2/3) ≈ 0.83
```

→ Max achievable score is ~83 (gold/platinum border).

**All signals exist** (full formula):

```
activeWeight = 0.35 + 0.25 + 0.20 + 0.20 = 1.0
scale = 1.0
coverageFactor = 0.5 + 0.5 × (3/3) = 1.0

trust_score = (
  score_reliability  × 0.35 +
  score_repeat_usage × 0.25 +
  score_reviews      × 0.20 +
  score_volume       × 0.20
) × 100
```

→ Original v8 schema weights apply directly. No cap.

**No data at all**:

```
trust_score = 0 → tier = "unverified"
```

---

## Data Pipeline

Trust scores are computed as Phase 3 of the ingestion pipeline (`npm run ingest`):

```
Phase 1: Marketplace Sync
  GET /marketplace?side=all → upsert agents, plans, agent_services, blockchain_sync

Phase 2: Blockchain Order Scan
  For each agent wallet in blockchain_sync (event_type='order'):
    Fetch USDC transfers from Etherscan V2 (Base Sepolia, chainid 84532)
    Filter to received-only transfers
    Insert into orders table (ON CONFLICT tx_hash DO NOTHING)
    Upsert agent_computed_stats (total_orders, unique_buyers, repeat_buyers)
    Advance blockchain_sync checkpoint

Phase 3: Trust Score Computation
  For each active agent:
    Query order stats, burn stats, review stats
    Compute adaptive-weighted trust score
    Upsert trust_scores (score, tier, component scores)
```

---

## Database Tables

| Table | Role |
|-------|------|
| `orders` | Raw USDC transfer events from blockchain |
| `agent_computed_stats` | Aggregated order/burn counts per agent |
| `reviews` | User-submitted ratings (verified by burn tx) |
| `trust_scores` | Final computed score, tier, and component scores |
| `blockchain_sync` | Per-wallet/plan checkpoint for incremental scanning |

---

## Commands

```bash
npm run ingest          # Full pipeline: sync + scan + trust scores
npm run ingest:reset    # Wipe all data and reset checkpoints
npm run ingest:once     # Marketplace sync only (no blockchain scan)
```
