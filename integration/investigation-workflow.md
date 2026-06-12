# Investigation workflow integration

A linear walkthrough of the OnChainRisk API for an investigation platform: take an address, score it, expand its on-chain neighbours, watch it for activity, receive webhook alerts, and keep audit-ready report records.

This guide is for **technical integrators**. Every step has a `curl` example. Replace `YOUR_API_KEY` and `0xYourAddress` placeholders before running.

---

## 1. Choose a tier

| Tier | Base URL | Auth header | Use for |
|---|---|---|---|
| **Sandbox** | `https://api.onchainrisk.io` | `Authorization: Bearer ocr_test_*` | Wiring up your client, validating response shapes, integration testing. **No charges, no persisted reports.** |
| **Paid** | `https://api.onchainrisk.io` | `Authorization: Bearer ocr_live_*` | Production traffic with full analysis depth and persisted reports. |

Same host. The key prefix decides which tier you are on. Create keys in the dashboard at `https://app.onchainrisk.io/dashboard/api-keys`.

> **Sandbox is not paid graph.** Sandbox responses gate or empty out paid-only fields (`crossChain`, `tokenFlow`, `clusters`, etc.) and limit the graph to a 7-day, 1-hop, capped preview. See `capability-matrix.md` for the exact differences.

---

## 2. Score an address — `POST /api/v1/check`

The first call in any investigation. Returns a risk score, level, label info, pattern flags, and (paid only) clustering, cross-chain, and other deeper signals.

**Sandbox:**
```bash
curl -X POST https://api.onchainrisk.io/api/v1/check \
  -H "Authorization: Bearer ocr_test_PLACEHOLDER" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xYourAddress",
    "network": "eth"
  }'
```

**Paid** is identical except for the key prefix.

**Response (paid, abbreviated):**
```json
{
  "success": true,
  "data": {
    "address": "0x...",
    "network": "eth",
    "riskScore": 42,
    "riskLevel": "medium",
    "labels": ["..."],
    "patternFlags": ["bulk_collection"],
    "crossChain": { "...": "..." },
    "clusters": { "...": "..." },
    "_sandbox": null
  }
}
```

**Sandbox responses** also return `data` but include a `_sandbox` block (`profile: "sandbox"`, `coverage_days: 7`, `gated_fields: [...]`) and replace gated paid-only fields with `null` or `[]`.

**Validation errors** return HTTP **422** with `error.code = "VALIDATION_ERROR"` and `error.details.errorCode` carrying a stable machine code (`INVALID_ADDRESS`, `UNSUPPORTED_NETWORK`, `ADDRESS_NETWORK_MISMATCH`).

**Async path:** for high-volume EVM addresses the API may return HTTP **202** with a `reportId`. Poll `GET /api/v1/check/status/{reportId}` until `status: "complete"` or `"failed"` — this status endpoint is lifecycle-only. Once complete, fetch the full report with `GET /api/reports/{reportId}` (see § Reports below). Light addresses return synchronously.

---

## 3. Expand neighbours

Two endpoints, **different products** despite the similar name. Pick by tier:

### 3a. Sandbox preview — `POST /api/v1/sandbox/graph/expand`

Cheap, depth-1, last-7-days, ≤20 nodes / ≤30 edges. **For integration testing.** No reports persisted, no usage rows.

```bash
curl -X POST https://api.onchainrisk.io/api/v1/sandbox/graph/expand \
  -H "Authorization: Bearer ocr_test_PLACEHOLDER" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xYourAddress",
    "network": "eth",
    "depth": 1
  }'
```

`depth` is silently clamped to 1 — `_sandbox.truncated_fields.depth = "max_1"` is reported back if requested >1.

**Supported networks (16):** `eth, arbitrum, optimism, base, polygon, avalanche, linea, zksync, scroll, celo, cronos, fantom, moonbeam, polygon_zkevm, bsc, tron`. Other networks return **422** `NETWORK_NOT_SUPPORTED_IN_SANDBOX`.

### 3b. Paid graph — `POST /api/graph/expand`

One-hop counterparty expansion for any address. **Multi-hop is iterative on the client side** — call this endpoint per node you want to expand. There is no single-call multi-hop API.

```bash
curl -X POST https://api.onchainrisk.io/api/graph/expand \
  -H "Authorization: Bearer ocr_live_PLACEHOLDER" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xYourAddress",
    "network": "eth"
  }'
```

Returns up to 20 aggregated counterparty edges. Logged as a `graph_expand` action — does **not** count toward your monthly check quota. Plan-level rate limits still apply (see `capability-matrix.md`).

**Supported networks (22):** all sandbox networks plus `btc, ltc, sol, ton, cosmos, cardano, xrp`.

---

## 4. Watchlist — `POST /api/watchlist`

Add an address to your monitored list. Cron checks each item every ~5 minutes for new transactions.

```bash
curl -X POST https://api.onchainrisk.io/api/watchlist \
  -H "Authorization: Bearer ocr_live_PLACEHOLDER" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xYourAddress",
    "network": "eth",
    "label": "Investigation #42",
    "notify_email": true,
    "notify_telegram": false,
    "notify_webhook": true
  }'
```

Per-item delivery toggles: `notify_email`, `notify_telegram`, `notify_webhook`. Account-level webhook URL is configured separately in step 5.

**CRUD endpoints:**
- `GET /api/watchlist` — list items
- `GET /api/watchlist/{id}/alerts` — per-item alert history
- `PATCH /api/watchlist/{id}` — update
- `DELETE /api/watchlist/{id}` — remove
- `GET /api/alerts` — account-wide alert feed

---

## 5. Webhook setup — `PATCH /api/notifications/settings`

Account-level. Register your webhook URL once; it is used for every watchlist item with `notify_webhook: true`.

```bash
curl -X PATCH https://api.onchainrisk.io/api/notifications/settings \
  -H "Authorization: Bearer ocr_live_PLACEHOLDER" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_enabled": true,
    "webhook_url": "https://your-backend.example.com/onchainrisk-webhook",
    "webhook_secret": "your-shared-secret"
  }'
```

**HMAC verification, latency, retry expectations, payload sample** — see `webhooks.md`.

You can call `POST /api/notifications/test` to send a test alert through every enabled channel.

---

## 6. Reports

Sandbox: **no persisted reports**. Every sandbox call is stateless.

Paid: every `/api/v1/check` call writes a row to your `reports` history.

```bash
# List
curl -H "Authorization: Bearer ocr_live_PLACEHOLDER" \
  https://api.onchainrisk.io/api/reports

# Detail
curl -H "Authorization: Bearer ocr_live_PLACEHOLDER" \
  https://api.onchainrisk.io/api/reports/{public_id}
```

Programmatic export to PDF/XLSX/Markdown is **not** in the API today. Reports are exportable from the dashboard. Roadmap.

---

## 7. End-to-end flow (Node)

Minimal end-to-end script. Plain Node.js 18+ `fetch`, no SDK. Reads `ONCHAINRISK_API_KEY` and `ONCHAINRISK_BASE_URL` from environment. Auto-routes sandbox vs paid by key prefix.

```js
// investigate-and-watch.mjs
// Run: ONCHAINRISK_API_KEY=ocr_test_yourkey node investigate-and-watch.mjs

const API_KEY  = process.env.ONCHAINRISK_API_KEY;
const BASE_URL = process.env.ONCHAINRISK_BASE_URL || 'https://api.onchainrisk.io';
const ADDRESS  = process.env.ONCHAINRISK_ADDRESS  || '0xYourAddress';
const NETWORK  = process.env.ONCHAINRISK_NETWORK  || 'eth';

if (!API_KEY) {
  console.error('ONCHAINRISK_API_KEY required (ocr_test_* sandbox or ocr_live_* paid)');
  process.exit(1);
}
const isSandbox = API_KEY.startsWith('ocr_test_');

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${method} ${path}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// 1. Score
const check = await call('POST', '/api/v1/check', { address: ADDRESS, network: NETWORK });
console.log('riskScore:', check.data.riskScore, 'level:', check.data.riskLevel);

// 2. Expand graph (sandbox vs paid endpoint based on key)
const graphPath = isSandbox ? '/api/v1/sandbox/graph/expand' : '/api/graph/expand';
const graphBody = { address: ADDRESS, network: NETWORK, ...(isSandbox && { depth: 1 }) };
const graph = await call('POST', graphPath, graphBody);
const nodes = graph.data?.nodes ?? graph.nodes ?? [];
const edges = graph.data?.edges ?? graph.edges ?? [];
console.log('graph:', nodes.length, 'nodes,', edges.length, 'edges');

// 3. Add to watchlist (paid only — sandbox cannot mutate watchlist)
if (!isSandbox) {
  const watch = await call('POST', '/api/watchlist', {
    address: ADDRESS, network: NETWORK,
    label: 'Investigation #1',
    notify_email: true, notify_webhook: false,
  });
  console.log('watchlist item id:', watch.data.id);
} else {
  console.log('watchlist: skipped (sandbox tier).');
}
```

For webhook signature verification (when you wire up watchlist alerts), see the **Node verifier** snippet inlined in `webhooks.md`.

---

## 8. Production checklist

Before you go live with paid traffic:

- [ ] Tested integration end-to-end against sandbox (`ocr_test_*`) keys.
- [ ] Validated your error path: 422 (validation), 401 (auth), 429 (rate limit), 503 (analysis temporarily unavailable).
- [ ] Implemented webhook signature verification (`X-Signature-256`, HMAC SHA-256). See `webhooks.md`.
- [ ] **Implemented webhook retry on your side.** OnChainRisk delivers each alert exactly once today (single attempt). If your endpoint is briefly unavailable, the alert is logged on our side and not retried. We plan to ship retries; until then, enqueue inbound webhooks immediately and process from your queue.
- [ ] Read your plan's rate limits (`capability-matrix.md`) and parallelised your `/api/v1/check` workload accordingly.
- [ ] Decided whether to use the async path explicitly (`/api/v1/check/status/...`) or rely on the API's automatic sync/async routing.

---

## What is NOT available today

To set realistic expectations:

- **No native WhatsApp integration.** Architecture: OnChainRisk webhook → your backend → WhatsApp Business API / Twilio.
- **No WebSockets / streaming endpoint.** Pull via HTTP, or react to webhook alerts.
- **No single-call multi-hop graph.** Iterate per node.
- **No bulk endpoint.** Issue parallel `/api/v1/check` calls within your tier's rate limit.
- **No published SDK.** Use `openapi-generator-cli` against the OpenAPI spec to generate a typed client in your language.
- **No programmatic export API for PDF/XLSX/Markdown.** Use dashboard exports for now.
- **No webhook retries today.** Single attempt per alert. Hardening planned.

---

## See also

- `sandbox-graph-quickstart.md` — fastest path to a first sandbox graph response.
- `capability-matrix.md` — paid vs sandbox feature comparison, networks, rate limits, plan quotas.
- `webhooks.md` — payload sample, HMAC verification, latency.
- OpenAPI: [`https://api.onchainrisk.io/openapi.yaml`](https://api.onchainrisk.io/openapi.yaml) (paid), [`https://api.onchainrisk.io/openapi-sandbox.yaml`](https://api.onchainrisk.io/openapi-sandbox.yaml) (sandbox).
- Postman: [`postman-paid-collection.json`](https://api.onchainrisk.io/postman-paid-collection.json), [`postman-sandbox-collection.json`](https://api.onchainrisk.io/postman-sandbox-collection.json), with environments `postman-paid-environment.json`, `postman-sandbox-environment.json`.
