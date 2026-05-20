# Sandbox graph quickstart

Get a first sandbox graph response in under five minutes. This page is the integration-test entry point for any client that wants to wire up OnChainRisk graph data without paying for analysis or persisting reports.

> **Sandbox graph is a preview, not the paid graph.** Limited to depth 1, last 7 days, ≤20 nodes / ≤30 edges, and a subset of networks. For the full graph, use paid `/api/graph/expand`. See `capability-matrix.md` for the comparison.

---

## 1. Get a sandbox API key

Sign up at `https://app.onchainrisk.io/register` and create a sandbox key in the dashboard at `https://app.onchainrisk.io/dashboard/api-keys`.

Sandbox keys start with the `ocr_test_*` prefix. Free-tier accounts can mint one sandbox key.

---

## 2. Make a call

**Endpoint:** `POST /api/v1/sandbox/graph/expand`

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

Replace `ocr_test_PLACEHOLDER` with your real sandbox key and `0xYourAddress` with the address you want to inspect.

---

## 3. Limits

| Field | Value |
|---|---|
| `depth` | Capped at **1**. Higher values are silently clamped — surfaced via `_sandbox.truncated_fields.depth: "max_1"`. |
| Lookback window | Last **7 days** only. Aggregated edge fields (`txCount`, `value`, `firstTx`, `lastTx`) reflect only transactions in this window. |
| Max nodes | **20** |
| Max edges | **30** |
| Cache TTL | 15 minutes (per address+network) |

These limits are enforced server-side before aggregation and again at the API boundary. You cannot exceed them by tweaking request parameters.

---

## 4. Supported networks (13)

EVM family:
```
eth, arbitrum, optimism, base, polygon, avalanche, zksync,
scroll, celo, cronos, moonbeam
```
Plus: `bsc`, `tron`.

**Not supported in sandbox graph (will return 422):** `btc`, `ltc`, `sol`, `ton`, `cosmos`, `cardano`, `xrp`, `linea`, `fantom`, `polygon_zkevm`. Paid `/api/graph/expand` adds `btc`, `ltc`, `sol`, `ton` (and re-includes `linea`, `fantom`, `polygon_zkevm` for paid traversal — only sandbox-side is currently disabled for those three). `cosmos`, `cardano`, `xrp` are not in any graph today; they only work in `/api/v1/check`. See `capability-matrix.md` for the per-endpoint network table.

> `linea`, `fantom`, `polygon_zkevm` were removed from sandbox graph 2026-05-04 because the upstream analyzer returns 503 in production. They will be restored once the provider config is fixed.

---

## 5. Sample response

```json
{
  "success": true,
  "data": {
    "address": "0x...",
    "network": "eth",
    "nodes": [
      {
        "address": "0x...",
        "label": null,
        "isTarget": false,
        "totalValue": "1.5 ETH",
        "txCount": 3,
        "tokens": []
      }
    ],
    "edges": [
      {
        "from": "0x...",
        "to": "0x...",
        "fromLabel": null,
        "toLabel": null,
        "value": "1.5 ETH",
        "valueWei": "1500000000000000000",
        "txCount": 3,
        "firstTx": 1700000000,
        "lastTx": 1700001234,
        "tokenBreakdown": []
      }
    ],
    "partial": true,
    "_sandbox": {
      "profile": "sandbox",
      "coverage_days": 7,
      "reports_saved": false,
      "partial": true,
      "limits": { "depth": 1, "max_nodes": 20, "max_edges": 30 },
      "truncated_fields": { "history": "last_7_days" },
      "gated_fields": [
        "clusters",
        "entityExpansion",
        "crossChainGraph",
        "historicalTraversal",
        "aiSummary"
      ],
      "upgrade_url": "https://onchainrisk.io/pricing",
      "docs_url": "https://onchainrisk.io/docs/sandbox"
    }
  }
}
```

The aggregated edge shape (`from`/`to`/`value`/`valueWei`/`txCount`/`firstTx`/`lastTx`/`tokenBreakdown`) **mirrors paid `/api/graph/expand`**. You can re-point your client at the paid endpoint later without rewriting response handling.

---

## 6. Empty arrays are valid

Some addresses may return `nodes: []` and `edges: []` if they have **no recent activity in the last 7 days**. This is **valid behavior**, not an error.

To see populated graph data while testing, replace the address with one you know is currently active (a wallet you control, or an address with confirmed recent transactions in the last 7 days).

> Vitalik's public address `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` is occasionally cited as a "well-known address" example, but in any given 7-day window it may have zero ETH transactions. If you copy-paste it and see empty arrays, that's the window filter doing its job — not a bug.

`partial: true` means at least one of: tx fetch hit the cap, nodes were truncated, edges were truncated, or upstream flagged the response as partial. Inspect `_sandbox.truncated_fields` to see exactly which limit fired.

---

## 7. depth clamping

```bash
curl ... -d '{"address":"0xYourAddress","network":"eth","depth":5}'
```

Returns the same depth-1 response, with `_sandbox.truncated_fields.depth = "max_1"` reported back so you know the clamp happened. Sandbox does not error on `depth > 1` — it clamps.

---

## 8. Error handling

| HTTP | When | Body shape |
|---|---|---|
| **401** | Missing or invalid Bearer; JWT/session token (use API key, not browser session) | `{success:false, error:{code:"UNAUTHORIZED" \| "API_KEY_REQUIRED"}}` |
| **422** | Validation failed (address, network, unsupported sandbox network) | `{success:false, error:{code:"VALIDATION_ERROR", details:{errorCode:"...", ...}}}` |
| **429** | Rate limit exceeded (per-key bucket, per-IP bucket) | `{success:false, error:"rate_limit_exceeded", bucket, retry_after_seconds}` |
| **503** | Sandbox graph temporarily unavailable (upstream issue) | `{success:false, error:{code:"SANDBOX_GRAPH_UNAVAILABLE"}}` |

Stable `errorCode` values for 422: `INVALID_ADDRESS`, `UNSUPPORTED_NETWORK`, `ADDRESS_NETWORK_MISMATCH`, `INVALID_REQUEST`, `NETWORK_NOT_SUPPORTED_IN_SANDBOX`.

---

## 9. Rate limits

Sandbox keys: 20 burst / 10 per minute per-key bucket, 30 burst / 30 per minute per-IP bucket. Token-bucket algorithm. 429s include a `Retry-After` header.

Paid keys can also call this endpoint (the response is still sandbox-shaped); they bypass the sandbox bucket and use their plan-tier rate limit instead.

---

## 10. Postman

Drop these into Postman for a one-click setup:
- Collection: [`postman-sandbox-collection.json`](https://api.onchainrisk.io/postman-sandbox-collection.json)
- Environment: [`postman-sandbox-environment.json`](https://api.onchainrisk.io/postman-sandbox-environment.json) — set `sandbox_api_key` and `sample_address` to your values.

The collection includes a "Graph preview — sample (depth=1, last 7d)" item with response shape assertions baked in.

---

## See also

- `investigation-workflow.md` — how sandbox graph fits in the broader check → graph → watch → webhook flow.
- `capability-matrix.md` — sandbox vs paid graph differences, supported networks per tier.
- OpenAPI sandbox: [`https://api.onchainrisk.io/openapi-sandbox.yaml`](https://api.onchainrisk.io/openapi-sandbox.yaml).
