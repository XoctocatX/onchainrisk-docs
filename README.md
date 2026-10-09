# OnChainRisk API

**Blockchain analytics & wallet risk-scoring API** — analyze wallet activity across 23 supported networks, with coverage and analysis depth varying by network and endpoint. Score wallets 0–100, trace fund flows, and detect scam/exploit/mixer patterns.

- **API hub:** https://onchainrisk.io/blockchain-analytics-api/
- **Platform:** https://onchainrisk.io
- **Get an API key:** https://app.onchainrisk.io/dashboard/api-keys

---

## Get started in ~60s

1. **Create a sandbox API key** → https://app.onchainrisk.io/dashboard/api-keys (free-tier accounts can create a sandbox key; sandbox keys are prefixed `ocr_test_`).
2. **Run a test call** in sandbox — `POST /api/v1/check` with `Authorization: Bearer <your sandbox key>`.
3. **Inspect the result** — `riskScore` (0–100), `riskLevel` (`high`/`medium`/`low`), and risk signals in `patternFlags` / `riskReasons`.
4. **Upgrade to a paid key** for production / full checks once your integration is tested.

```bash
export ONCHAINRISK_API_KEY="ocr_test_your_sandbox_key"

curl -s https://api.onchainrisk.io/api/v1/check \
  -H "Authorization: Bearer $ONCHAINRISK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","network":"eth"}'
```

> **Sandbox is for integration testing** — confirm auth, validate response shapes, and wire your client against real addresses (cheap modules, recent-activity window). **Paid keys are for production / full checks.** The same `POST /api/v1/check` works with both: a sandbox key returns the sandbox profile (with a `_sandbox` marker and some expensive fields gated); a paid key returns the full analysis. See the [sandbox docs](https://api.onchainrisk.io/sandbox-docs). Replace the address with `0xYOUR_ADDRESS`.

---

## Examples

**Server:** `https://api.onchainrisk.io` · **Auth:** `Authorization: Bearer $ONCHAINRISK_API_KEY` · **Endpoint:** `POST /api/v1/check` (same call for a sandbox `ocr_test_` key or a paid key)

### curl

```bash
curl -s https://api.onchainrisk.io/api/v1/check \
  -H "Authorization: Bearer $ONCHAINRISK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"0xYOUR_ADDRESS","network":"eth"}'
```

### Python (`requests`)

```python
import os, requests

key = os.environ["ONCHAINRISK_API_KEY"]

r = requests.post(
    "https://api.onchainrisk.io/api/v1/check",
    headers={"Authorization": f"Bearer {key}"},
    json={"address": "0xYOUR_ADDRESS", "network": "eth"},
    timeout=30,
)
r.raise_for_status()
data = r.json()
print(data["riskScore"], data["riskLevel"], data["patternFlags"])
```

### JavaScript / Node (`fetch`)

```js
const key = process.env.ONCHAINRISK_API_KEY;

const res = await fetch("https://api.onchainrisk.io/api/v1/check", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ address: "0xYOUR_ADDRESS", network: "eth" }),
});
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const data = await res.json();
console.log(data.riskScore, data.riskLevel, data.patternFlags);
```

---

## Sample response

Trimmed from the OpenAPI spec (see [`openapi.yaml`](https://api.onchainrisk.io/openapi.yaml) for the full `AnalysisResult` schema). Wallet (EOA) and contract responses share the same shape; contracts add `contractAnalysis` / `contractInfo`. **Sandbox** responses keep this same core envelope and add a `_sandbox` object (`profile: "sandbox"`) with some expensive fields gated — see the [sandbox docs](https://api.onchainrisk.io/sandbox-docs).

```json
{
  "address": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "network": "eth",
  "riskScore": 5,
  "riskLevel": "low",
  "addressInfo": {
    "type": "eoa",
    "balance": "1.2 ETH",
    "txCount": 412,
    "firstSeen": "2020-06-09T18:43:35Z",
    "lastSeen": "2026-04-25T10:11:02Z"
  },
  "patternFlags": [],
  "dataCompleteness": {
    "reportedTxCount": 412,
    "fetchedTxCount": 412,
    "completenessPct": 100,
    "partialReason": null
  },
  "analysisTime": 4321,
  "timestamp": "2026-04-25T10:15:00Z"
}
```

Risk signals surface in `patternFlags` (human-readable, e.g. `"OFAC/sanctions list match"` or `"BULK COLLECTION pattern: 24 inbound TXs in 600s"`) and in the structured `riskReasons` array. Sanctions checks are applied **where supported** — see the OpenAPI spec for the exact fields.

---

## Auth, quota & errors

- **Auth:** every request needs `Authorization: Bearer <API key>`. Create/rotate keys at https://app.onchainrisk.io/dashboard/api-keys — **sandbox keys** (`ocr_test_`, free-tier) for integration testing, **paid keys** for production / full checks.
- **Quota:** in production, a fresh `POST /api/v1/check` costs **1 check**; `GET /api/v1/check/{address}` returns cache for free (add `?force=true` to force a fresh check). Responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-Credits-Remaining` headers.
- **Errors:** `401` unauthorized (missing/invalid key), `429` quota or rate limit exceeded, `404` not found.

Full request/response detail, parameters, and every endpoint: **[OpenAPI spec](https://api.onchainrisk.io/openapi.yaml)** · **[API reference](https://api.onchainrisk.io/docs)**.

---

## Links

- **API hub:** https://onchainrisk.io/blockchain-analytics-api/
- **OpenAPI spec:** https://api.onchainrisk.io/openapi.yaml
- **API reference:** https://api.onchainrisk.io/docs
- **Sandbox docs:** https://api.onchainrisk.io/sandbox-docs
- **Postman (paid):** https://api.onchainrisk.io/postman-paid-collection.json
- **Postman (sandbox):** https://api.onchainrisk.io/postman-sandbox-collection.json
- **Postman environment (paid):** [paid.postman_environment.json](paid.postman_environment.json)
- **Postman environment (sandbox):** [sandbox.postman_environment.json](sandbox.postman_environment.json)
- **Webhooks integration guide:** [integration/webhooks.md](integration/webhooks.md)
- **Live coverage matrix:** https://app.onchainrisk.io/coverage
- **Get an API key:** https://app.onchainrisk.io/dashboard/api-keys

---

## What is OnChainRisk?

OnChainRisk is a blockchain forensics platform that helps investigators, compliance teams, and individuals assess the risk of any crypto wallet address. It combines transaction analysis, pattern detection, entity labeling, and AI-powered investigation into a single tool — accessible at a fraction of the cost of enterprise solutions. Supports a 23-network product set including Ethereum, Bitcoin, Solana, and Layer 2 ecosystems; coverage depth and endpoint availability vary by network — see the [live coverage matrix](https://app.onchainrisk.io/coverage).

## Key features

- **Wallet risk scoring** — a 0–100 risk score from transaction patterns, counterparty risk, sanctions checks (where supported), and behavioral signals.
- **Fund flow tracing** — interactive graph of fund movements; expand nodes and trace paths across multiple hops.
- **Multi-chain analysis** — scan balances/holdings with `/api/v1/multichain/scan`, and run composite risk analysis with `/api/v1/multichain/analyze`. The two are distinct: `scan` returns holdings only and does not risk-score.
- **AI investigation agent** — automated wallet analysis and fund tracing through natural-language conversation.
- **Block MEV analysis** — sandwich attacks, arbitrage, flash loans, and ordering manipulation across 10 EVM networks.
- **Token security scoring** — honeypot risk, buy/sell tax simulation, ownership concentration, and liquidity.
- **Scam detection** — pig butchering, address poisoning, rug pulls, and mixer interactions.
- **Court-ready export format** — export PDF, CSV, XLSX, or Markdown reports with fund-flow diagrams and evidence chains. "Court-ready" is the name of the export format; it is not a guarantee of legal admissibility, evidentiary weight, chain-of-custody certification, or expert attestation in any jurisdiction.

## Supported networks (23)

> **What "supported" means here.** 23 is the product network set — the networks `POST /api/v1/check`
> accepts at validation. Acceptance is not a statement of coverage depth: historical window and data
> path vary by network, and the [live coverage matrix](https://app.onchainrisk.io/coverage) is the authoritative source for current
> depth and rollout stage. Endpoint-specific support is narrower than 23 for several endpoints — deep
> analysis 14, token check 10, block analyze 10, paid graph expand 20, sandbox graph 13 — with the exact
> sets and error codes in [integration/capability-matrix.md](integration/capability-matrix.md).

| Layer 1 | Layer 2 | Other |
|---------|---------|-------|
| Ethereum | Arbitrum | Cosmos |
| BNB Chain (BSC) | Optimism | Cardano |
| Bitcoin | Base | XRP |
| Solana | Polygon | |
| Tron | Avalanche | |
| TON | Linea | |
| Litecoin | zkSync Era | |
| | Scroll | |
| | Celo | |
| | Cronos | |
| | Fantom | |
| | Moonbeam | |
| | Polygon zkEVM | |

## Use cases

- **Compliance teams** — AML/KYT screening, sanctions checks (where supported), transaction monitoring
- **Law enforcement** — trace stolen funds, identify exchange deposits, generate evidence
- **Security researchers** — investigate DeFi exploits, track attacker wallets
- **Exchanges** — screen deposits/withdrawals, block high-risk addresses
- **Individuals** — verify wallets before sending funds, check for scam activity

## Guides

- [How to investigate a crypto address](https://onchainrisk.io/how-to-investigate-crypto-address/)
- [How to analyze a crypto wallet for risk](https://onchainrisk.io/how-to-analyze-crypto-wallet/)
- [How to trace stolen cryptocurrency](https://onchainrisk.io/how-to-trace-stolen-crypto/)
- [How to check if a wallet is a scam](https://onchainrisk.io/how-to-detect-scam-wallet/)
- [What is a crypto wallet risk score?](https://onchainrisk.io/what-is-crypto-risk-score/)

## Contact

- Website: [onchainrisk.io](https://onchainrisk.io)
- Twitter: [@onchainrisk_io](https://twitter.com/onchainrisk_io)
- Email: admin@onchainrisk.io
