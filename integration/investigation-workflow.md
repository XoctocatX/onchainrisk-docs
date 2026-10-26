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

> **Sandbox:** this whole flow is now exercisable on an `ocr_test_*` key, which it was not before #735 Slice 6 — the two endpoints above used to answer `403` to a sandbox key even though this page told you to poll them. Two documented fixture addresses take the async path (`0x0000000000000000000000000000000000735a01` reaches `complete`, `0x0000000000000000000000000000000000735f01` reaches `failed`); every other sandbox address stays synchronous, and there is no request flag. The sandbox lifecycle is deterministic and simulated — `queued` for 2s, `analyzing` until 6s, then terminal, readable for an hour — with no queue, no provider call and no billing. The contract is identical to paid, so the polling loop you write here is the one you keep after switching the credential.

---

## 3. Expand neighbours — `POST /api/graph/expand`

ONE endpoint, both tiers. Same method, same path, same request and response contract; your
credential selects the execution. Multi-hop is iterative on the client side — call this endpoint
per node you want to expand. There is no single-call multi-hop API.

```bash
curl -X POST https://api.onchainrisk.io/api/graph/expand \
  -H "Authorization: Bearer $OCR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xYourAddress",
    "network": "eth"
  }'
```

**With an `ocr_test_*` key (sandbox execution):** bounded — real address and network, depth 1, last
7 days, ≤20 nodes / ≤30 edges, no billing, no persistence. `depth` is silently clamped to 1 and
`_sandbox.truncated_fields.depth = "max_1"` is reported back if you ask for more.

**With an `ocr_live_*` key (paid execution):** up to 20 aggregated counterparty edges over the full
history. Logged as a `graph_expand` action — does **not** count toward your monthly check quota.
Plan-level rate limits still apply (see `capability-matrix.md`).

The edge shape is identical on both tiers, so a client written against sandbox needs no response
handling changes when you swap the credential.

**Networks, sandbox execution (13):** `eth, arbitrum, optimism, base, polygon, avalanche, zksync,
scroll, celo, cronos, moonbeam, bsc, tron` (source of truth: `SANDBOX_GRAPH_SUPPORTED_NETWORKS` in
`web/api/src/config/sandbox-policy.js`). Every other network — including `linea`, `fantom` and
`polygon_zkevm`, removed on 2026-05-04 after upstream 503s — returns **422**
`NETWORK_NOT_SUPPORTED_IN_SANDBOX`.

**Networks, paid execution (20):** the 14 EVM networks plus `bsc`, `tron`, `btc`, `ltc`, `sol`,
`ton` — i.e. paid covers `linea`, `fantom` and `polygon_zkevm` (which sandbox execution does not)
and adds the non-EVM UTXO/account chains. Authority: `EVM_NETWORKS` (14) plus the dedicated `tron` /
`btc` / `ltc` / `sol` / `ton` / `bsc` branches in `web/api/main.py::_get_counterparties`. The three
remaining accepted networks — `xrp`, `cosmos`, `cardano` — have no graph-expand handler and return
**422** `NETWORK_ANALYSIS_NOT_AVAILABLE_FOR_ENDPOINT`. A handler existing does not guarantee edges:
per-network depth is upstream-dependent, and an upstream failure surfaces as **503**
`EXPAND_UNAVAILABLE` rather than a silent empty graph.

*Migration note:* existing integrations calling the historical sandbox graph path
`/api/v1/sandbox/graph/expand` continue to work unchanged. It is no longer part of the published
contract, so new integrations should use `POST /api/graph/expand`.

---

## 4. Watchlist — `POST /api/watchlist`

Add an address to your monitored list. On the paid API a job checks each item every ~5 minutes for
new transactions and delivers alerts through your enabled channels.

**On sandbox (`ocr_test_*`) the same six operations run, and nothing is monitored.** Since #748
Slice E the whole CRUD lifecycle — create, list, update, soft delete, re-activate — is real
owner-scoped sandbox state with the paid request and response contracts, so the client code below
is the code you keep when you swap the key. What does NOT happen on sandbox: no scheduled job sees
your sandbox entries, no provider is polled, `is_contract`/`deployer_address` are not detected, and
no email, Telegram message or webhook is ever sent — the `notify_*` flags are contract data only.
The alert endpoints are exercisable because creating an entry seeds deterministic SIMULATED alerts
(synthetic `tx_hash`, `"simulated": true` in `details`, `notified_*` always 0). Sandbox entries and
their alerts expire 24 hours after their last change. Sandbox watchlist state is owned by the
ACCOUNT, not by the credential: every sandbox key on the same account sees and mutates the same
entries and the same alert history, and the limits of 25 active entries (50 including removed ones)
are per account — sandbox execution policy, not a plan quota. Different accounts stay isolated.

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

**On sandbox (`ocr_test_*`)** the same `GET`/`PATCH` run, and since #748 Slice F the settings are
REAL sandbox-owned state: owned by the account (every sandbox key on it shares them), with paid's
partial-update semantics and paid's response shape, and the first `GET` creates the defaults just
as paid's does. **Nothing is armed.** Whatever you enable, no email, Telegram message or webhook
request leaves the API on this tier, and a `webhook_secret` you send is never returned and never
used to sign anything. `GET /api/v1/webhook/deliveries` answers with a committed deterministic
FIXTURE so you can build and test your audit UI — those records are NOT evidence that any webhook
was sent, because the sandbox sends none. Telegram connect/disconnect stay paid-only. Sandbox
settings expire 24 hours after their last change.

---

## 6. Reports

Sandbox: **no persisted reports**. Every sandbox call is stateless.

Paid: every `/api/v1/check` call writes a row to your `reports` history.

**One route in this family is public: fetch by id.** Listing, renaming, deleting and
graph/share state are dashboard-internal and are not part of the integration API — keep the
`reportId` returned by the check response (or by the 202 async flow above) and fetch that report
directly.

```bash
# Detail — the published route. `reportId` comes from the /api/v1/check response.
curl -H "Authorization: Bearer ocr_live_PLACEHOLDER" \
  https://api.onchainrisk.io/api/reports/{reportId}
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

// 2. Expand graph — ONE path on both tiers; the credential selects the execution
const graph = await call('POST', '/api/graph/expand', { address: ADDRESS, network: NETWORK });
const nodes = graph.data?.nodes ?? graph.nodes ?? [];
const edges = graph.data?.edges ?? graph.edges ?? [];
console.log('graph:', nodes.length, 'nodes,', edges.length, 'edges');

// 3. Add to watchlist — the SAME call on both tiers since #748 Slice E. On sandbox the entry is
//    real sandbox-scoped state with the paid contract, and nothing monitors it or notifies you.
const watch = await call('POST', '/api/watchlist', {
  address: ADDRESS, network: NETWORK,
  label: 'Investigation #1',
  notify_email: true, notify_webhook: false,
});
console.log('watchlist item id:', watch.data.item.id, isSandbox ? '(sandbox: simulated)' : '');

// 4. Read its alert history. Paid fills this from real monitoring; sandbox returns the
//    deterministic simulated alerts seeded by the create above, in the same row shape.
const alerts = await call('GET', `/api/watchlist/${watch.data.item.id}/alerts`);
console.log('alerts:', alerts.data.total, '| details is a JSON STRING:',
  typeof alerts.data.alerts[0]?.details);
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
- Postman: [`postman-collection.json`](https://api.onchainrisk.io/postman-collection.json) — ONE collection for both tiers, used with the [Production](https://api.onchainrisk.io/postman-production-environment.json) or [Sandbox](https://api.onchainrisk.io/postman-sandbox-environment.json) environment. The credential is the only thing that changes.
