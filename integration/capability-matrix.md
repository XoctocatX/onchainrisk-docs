# Capability matrix — paid vs sandbox

A reference of what is in production today versus what is roadmap. Use this when deciding which tier and endpoints to integrate against, and what to promise downstream consumers.

Status as of **2026-05-20**.

> **Since the last update (2026-05-04):** `/api/v1/check/deep` capability surface is now a 14-network EVM set (see §3 below); `/api/v1/multichain/analyze` now applies user custom weights / overrides / labels (PR #76); the critical override floor surface expanded from 9 to 14 keys, aligned across Worker / Modal / Dashboard (PR #77 / PR #78); `/api/v1/token/check` re-enabled Tron support — token-check supported network count is now 10.

---

## 1. Feature comparison

| Feature | Sandbox | Paid | Notes |
|---|---|---|---|
| `POST /api/v1/check` (address risk score) | ✅ | ✅ | Sandbox responses gate paid-only fields. See "Field gating" below. |
| `POST /api/v1/check/deep` (deep analysis) | ❌ | ✅ | Paid only. 14 EVM networks supported (see §3). Saved custom weights/overrides/labels do **not** apply to deep — the response carries `peelChain` only (no `riskScore`). Unsupported networks return `422 DEEP_ANALYSIS_UNSUPPORTED_NETWORK`. |
| `POST /api/graph/expand` (paid graph, 1-hop) | ❌ | ✅ | Paid graph traversal. Up to 20 counterparties per call. |
| `POST /api/v1/sandbox/graph/expand` (preview) | ✅ | ✅ | Both key types route to the sandbox profile. Limited to 7d / 20 nodes / 30 edges / 16 networks. |
| Watchlist + alerts (`/api/watchlist`, `/api/alerts`) | ❌ | ✅ | Paid only. ~5-min cron cadence. |
| Webhooks (`/api/notifications/settings`) | ❌ | ✅ | HMAC SHA-256 signed (`X-Signature-256`). Single attempt per alert today (retries roadmap). |
| Reports persistence (`/api/reports`) | ❌ | ✅ | Sandbox is stateless; no rows written. |
| Multichain scan (`/api/v1/multichain/*`) | ❌ | ✅ | Paid only. `/api/v1/multichain/analyze` honors saved custom weights / overrides / labels (same surface as `/api/v1/check`) since 2026-05-20 (PR #76). `/api/v1/multichain/scan` is balance/holdings only — no risk scoring, so customs do not apply there. |
| Token security check (`/api/v1/token/check`) | ❌ | ✅ | Paid only. |
| Block analysis / MEV (`/api/v1/block/*`, `/api/v1/mev/*`) | ❌ | ✅ | Paid only. |
| Investigations (`/api/investigate*`, AI-assisted) | ❌ | ✅ | Paid only. |
| Custom labels (`/api/labels`, `/api/labels/import`, `/api/labels/export`) | Read-only (`GET /api/labels`) | ✅ Full CRUD + CSV | Sandbox can read but not mutate. |
| Entity clustering (`clusters` field on `/api/v1/check`) | ❌ (gated null) | ✅ | Production. Populated when target has labeled counterparties grouped into ≥2-member entities. May be `[]` for fresh wallets. |
| Cross-chain bridge detection (`crossChain` field) | ❌ (gated null) | ✅ | Production. 13 destination chains including Monero (flagged not-trackable). Coverage = curated bridge contract registry. |

---

## 2. Field gating in sandbox `/api/v1/check`

Sandbox responses follow the published sandbox policy reflected in the [Sandbox OpenAPI specification](https://api.onchainrisk.io/openapi-sandbox.yaml). Each paid response field falls into exactly one bucket:

- **`kept_real`** — returned as-is (e.g. `riskScore`, `riskLevel`, `addressInfo`, `labels`, `usdPrices`).
- **`gated_null`** — always `null` (e.g. `crossChain`, `tokenFlow`, `clusters`, `temporalClusters`, `nftWashTrading`, `osintIntelligence`, `honeypot`, `tokenScore`).
- **`gated_empty_array`** — always `[]` (e.g. `topCounterparties`, `addressConnections`, `contractDeployments`, `tokenTransferHistory`).
- **`truncated_7d`** — real data, last 7 days only (`transactionHistory`).
- **`truncated_top_n`** — real data, top-N capped (`patternFlags` capped at 5).
- **`omitted`** — absent from the response (e.g. `analysisMode`, `fullAnalysisAvailable`, `reportId`, `creditCharged`).

Authoritative list at runtime: `_sandbox.gated_fields[]` and `_sandbox.truncated_fields{}` in every sandbox response. The auto-generated truncation matrix is at [`docs/_sandbox_truncation_matrix.md`](../_sandbox_truncation_matrix.md).

---

## 3. Graph limits

> **Network coverage at a glance** (network *enum* differs from network *production-verified* coverage; both listed below):
>
> - `POST /api/v1/check` — **enum: 23 networks** accepted by validation. **Production-verified full analysis: 18 networks today** (eth, bsc, arbitrum, optimism, base, polygon, avalanche, linea, zksync, scroll, celo, cronos, moonbeam, btc, ltc, sol, ton, tron). **Currently unstable / partial in full analysis: `fantom`, `polygon_zkevm`, `cosmos`, `cardano`, `xrp`** — accepted by validation but full pipeline may return 503 from upstream analyzer. Tracked in audit #46 (P1-A).
> - `POST /api/graph/expand` (paid graph) — **20 networks** (subset; `cosmos`, `cardano`, `xrp` excluded from graph traversal entirely; `fantom` and `polygon_zkevm` traversal works in current testing but may timeout on hot contracts).
> - `POST /api/v1/sandbox/graph/expand` — **13 networks** (eth, arbitrum, optimism, base, polygon, avalanche, zksync, scroll, celo, cronos, moonbeam, bsc, tron). `linea`, `fantom`, `polygon_zkevm` removed from supported set 2026-05-04 (upstream 503 in production); these now return 422 `NETWORK_NOT_SUPPORTED_IN_SANDBOX`, restored once the provider config is fixed.
> - `POST /api/v1/check/deep` — **14 EVM networks** (eth, arbitrum, optimism, base, polygon, avalanche, linea, zksync, scroll, celo, cronos, fantom, moonbeam, polygon_zkevm). Non-EVM (btc, ltc, sol, ton, tron, cosmos, cardano, xrp) and any unlisted network return `422 DEEP_ANALYSIS_UNSUPPORTED_NETWORK` at the Worker boundary. Source-of-truth: `web/api/src/capabilities/deep-analysis.js`.
> - `POST /api/v1/token/check` — **10 networks** (eth, bsc, arbitrum, optimism, base, polygon, avalanche, linea, zksync, tron). Other networks return 422 `NETWORK_NOT_SUPPORTED_FOR_TOKEN_CHECK`. Tron was re-enabled 2026-05-18 (F-002b-2).
> - `POST /api/v1/block/analyze` — **10 networks** (eth, arbitrum, optimism, avalanche, scroll, linea, zksync, bsc, polygon, base). All 10 EVM block-analyze networks supported. `bsc` and `polygon` were re-enabled 2026-05-05 (Phase 2b) after the PoA / extended-extraData middleware fix in Modal RPCClient. `base` was re-enabled 2026-05-05 (Phase 2c) after the Modal BASE_RPC_URL secret was rotated to `https://mainnet.base.org`. Future-block requests (block number ahead of chain tip) return **404 `BLOCK_NOT_FOUND`** with the upstream's chain-tip number in the message; other upstream 4xx surface as 422 with the upstream reason; generic upstream failures stay 503.
>
> "Production-verified" = end-to-end success in our 2026-05-04 audit. "Enum" = networks the API will accept and forward to upstream. We don't refuse a request silently; we either succeed or return a specific 422/503 with structured error code.

### Paid graph — `POST /api/graph/expand`

| Parameter | Value |
|---|---|
| Depth | **1 hop per call.** Multi-hop is iterative on the client — call the endpoint per node you want to expand. There is no single-call multi-hop API. |
| Max nodes returned | **20** |
| Max edges returned | **20** (one aggregated edge per counterparty) |
| Per-network tx fetch caps | tron 2000 · bsc 5000 · sol 200 · eth and EVM L2s ~10k (Etherscan offset) · btc/ltc unbounded |
| Caching | KV-cached 1 hour per `(network, canonicalAddress)` |
| Quota cost | Logged as `graph_expand` action — does **not** count toward monthly check quota. Plan-tier rate limit applies. |
| Networks (20) | `eth, arbitrum, optimism, base, polygon, avalanche, linea, zksync, scroll, celo, cronos, fantom, moonbeam, polygon_zkevm, bsc, tron, btc, ltc, sol, ton`. **NOT supported in graph today: `cosmos`, `cardano`, `xrp`** — these networks work in `/api/v1/check` (full pipeline) but the graph traversal has no analyzer branch for them. Don't call `/api/graph/expand` with these networks; use them only in `/api/v1/check`. |

### Sandbox graph preview — `POST /api/v1/sandbox/graph/expand`

| Parameter | Value |
|---|---|
| Depth | 1 (silently clamped if `>1`; reported via `_sandbox.truncated_fields.depth: "max_1"`) |
| Max nodes | **20** |
| Max edges | **30** |
| Lookback | **7 days** — raw transactions filtered before aggregation, so `txCount`/`value`/`firstTx`/`lastTx` reflect only windowed data |
| Tx fetch cap | 100 per request (per network) |
| Caching | KV-cached 15 min per `(network, canonicalAddress)`, namespace `sb:expand:` (disjoint from paid `expand:`) |
| Quota cost | None. No usage row, no report row, no credit charge. |
| Networks (13) | `eth, arbitrum, optimism, base, polygon, avalanche, zksync, scroll, celo, cronos, moonbeam, bsc, tron`. Other networks (including `linea`, `fantom`, `polygon_zkevm` since 2026-05-04) → 422 `NETWORK_NOT_SUPPORTED_IN_SANDBOX`. |

> **Multi-hop**: in either tier, "depth-2" means: take the 20 counterparties from hop-1, call the same endpoint per counterparty for hop-2. That's 20 × 20 = up to 400 paths. **Plan your rate budget accordingly** — see rate limits below.

---

## 4. Rate limits per plan

### Paid keys (per-plan rate, requests per minute)

| Plan | Per minute | Per second (approx) | Notes |
|---|---|---|---|
| Free | 60 | 1 | **Dashboard only, no API keys issued.** |
| Pro | 600 | 10 | |
| Business | 3000 | 50 | |
| Enterprise | 6000 | 100 | |

Rate limits are enforced at the API layer. A `429` response is returned when the plan limit is exceeded. **Plan rate limits apply across all paid endpoints**, including `/api/graph/expand`.

### Sandbox keys (token bucket)

| Bucket | Capacity (burst) | Refill |
|---|---|---|
| Per key | 20 | 10 / min |
| Per IP | 30 | 30 / min |

Sandbox 429 body includes `bucket`, `retry_after_seconds`, `upgrade_url`. Free-tier accounts can issue one sandbox key.

---

## 5. Monthly check quotas

Counted only against **synchronous** `/api/v1/check`, `/api/v1/check/deep`, `/api/v1/multichain/scan` (5 credits), `/api/v1/token/check`, `/api/v1/block/analyze`. `graph_expand` does NOT count.

| Plan | Quota window | Quota |
|---|---|---|
| Free | Daily (rolling 24h) | 10 / day |
| Pro | Calendar month | 1000 / month |
| Business | Calendar month | 5000 / month |
| Enterprise | — | Unlimited (sentinel 999999) |

Overage is handled by **prepaid credits** (`/api/billing/credits/buy`). 1 credit = 1 sync check. Credits decrement before quota.

---

## 6. Production vs roadmap

### Production today (2026-05-04)
- All endpoints listed in `web/openapi.yaml` and `web/openapi-sandbox.yaml`.
- Sandbox graph preview (`/api/v1/sandbox/graph/expand`).
- Webhook delivery with HMAC SHA-256 signing.
- 22-network paid graph expansion (1-hop).
- Cross-chain bridge detection across 13 destination chains.
- Entity clustering on paid `/api/v1/check`.
- Async path for heavy EVM scans (auto-routed via `/api/analyze/estimate`, polled via `/api/v1/check/status/{reportId}`).

### Roadmap (not in production)
- **Webhook retries** — single attempt today; retries planned.
- **Single-call multi-hop graph** — iterate per node today.
- **Bulk endpoint** — issue parallel `/api/v1/check` today.
- **Programmatic export API (PDF / XLSX / Markdown)** — dashboard exports only today.
- **Native WhatsApp** — none today; integrate via your backend → WhatsApp Business API / Twilio.
- **WebSockets / streaming** — pull or webhook only.
- **Official SDK** — none today; use `openapi-generator-cli` against the OpenAPI spec.

These are roadmap items, not commitments. Don't promise downstream.

---

## 7. Auth scheme

| Auth method | Scope | Use for |
|---|---|---|
| API key (`Authorization: Bearer ocr_test_*`) | Sandbox endpoints | Integration testing |
| API key (`Authorization: Bearer ocr_live_*`) | All paid endpoints + sandbox preview | Production |
| JWT / session | Dashboard self-service surfaces only (excluded from public OpenAPI) | Browser only |

JWT/session is **rejected** on `/api/v1/sandbox/graph/expand` (returns 401 `API_KEY_REQUIRED`). This endpoint is API-key only by design — it's an integration surface, not a dashboard surface.

---

## See also

- `investigation-workflow.md` — end-to-end integration flow.
- `sandbox-graph-quickstart.md` — first sandbox graph call.
- `webhooks.md` — payload, HMAC, latency.
- OpenAPI: [paid](https://api.onchainrisk.io/openapi.yaml), [sandbox](https://api.onchainrisk.io/openapi-sandbox.yaml).
