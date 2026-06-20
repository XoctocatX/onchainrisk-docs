# OnChainRisk API

**Blockchain analytics & wallet risk-scoring API** — score any crypto wallet 0–100, trace fund flows, and detect scam/exploit/mixer patterns across 23 networks.

- **API hub:** https://onchainrisk.io/blockchain-analytics-api/
- **Platform:** https://onchainrisk.io
- **Get an API key:** https://app.onchainrisk.io/dashboard/api-keys

---

## Get started in ~60s

1. **Get an API key** → https://app.onchainrisk.io/dashboard/api-keys (Pro plan or higher for API access).
2. **Call the wallet risk API** with `Authorization: Bearer <your key>`.
3. **Read the result** — `riskScore` (0–100), `riskLevel` (`high`/`medium`/`low`), and risk signals in `patternFlags` / `riskReasons`.

```bash
export ONCHAINRISK_API_KEY="ocr_your_key_here"

curl -s https://api.onchainrisk.io/api/v1/check/0x742d35Cc6634C0532925a3b844Bc454e4438f44e \
  -H "Authorization: Bearer $ONCHAINRISK_API_KEY"
```

> `GET /api/v1/check/{address}` returns a **cached** report if one exists and does **not** consume quota. Add `?force=true` to run a fresh analysis (counts as one check), and `?network=eth` to pick a network. Replace the address with `0xYOUR_ADDRESS`.

---

## Examples

**Server:** `https://api.onchainrisk.io` · **Auth:** `Authorization: Bearer $ONCHAINRISK_API_KEY` · **Endpoint:** `GET /api/v1/check/{address}`

### curl

```bash
curl -s "https://api.onchainrisk.io/api/v1/check/0xYOUR_ADDRESS?network=eth" \
  -H "Authorization: Bearer $ONCHAINRISK_API_KEY"
```

### Python (`requests`)

```python
import os, requests

key = os.environ["ONCHAINRISK_API_KEY"]
address = "0xYOUR_ADDRESS"

r = requests.get(
    f"https://api.onchainrisk.io/api/v1/check/{address}",
    headers={"Authorization": f"Bearer {key}"},
    params={"network": "eth"},
    timeout=30,
)
r.raise_for_status()
data = r.json()
print(data["riskScore"], data["riskLevel"], data["patternFlags"])
```

### JavaScript / Node (`fetch`)

```js
const key = process.env.ONCHAINRISK_API_KEY;
const address = "0xYOUR_ADDRESS";

const res = await fetch(
  `https://api.onchainrisk.io/api/v1/check/${address}?network=eth`,
  { headers: { Authorization: `Bearer ${key}` } },
);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const data = await res.json();
console.log(data.riskScore, data.riskLevel, data.patternFlags);
```

---

## Sample response

Trimmed from the OpenAPI spec (see [`openapi.yaml`](https://api.onchainrisk.io/openapi.yaml) for the full `AnalysisResult` schema). Wallet (EOA) and contract responses share the same shape; contracts add `contractAnalysis` / `contractInfo`.

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

- **Auth:** every request needs `Authorization: Bearer <API key>`. Create/rotate keys at https://app.onchainrisk.io/dashboard/api-keys (API access requires Pro plan or higher).
- **Quota:** `GET /api/v1/check/{address}` returns cache and is free; a fresh analysis (`?force=true`, or `POST /api/v1/check`) costs **1 check**. Responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-Credits-Remaining` headers.
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
- **Get an API key:** https://app.onchainrisk.io/dashboard/api-keys

---

## What is OnChainRisk?

OnChainRisk is a blockchain forensics platform that helps investigators, compliance teams, and individuals assess the risk of any crypto wallet address. It combines transaction analysis, pattern detection, entity labeling, and AI-powered investigation into a single tool — accessible at a fraction of the cost of enterprise solutions. Supports 23 blockchain networks including Ethereum, Bitcoin, Solana, and Layer 2 ecosystems.

## Key features

- **Wallet risk scoring** — a 0–100 risk score from transaction patterns, counterparty risk, sanctions checks (where supported), and behavioral signals.
- **Fund flow tracing** — interactive graph of fund movements; expand nodes and trace paths across multiple hops.
- **Multi-chain wallet scan** — scan one address across 15 EVM networks with a composite score + per-network breakdown.
- **AI investigation agent** — automated wallet analysis and fund tracing through natural-language conversation.
- **Block MEV analysis** — sandwich attacks, arbitrage, flash loans, and ordering manipulation across 10 EVM networks.
- **Token security scoring** — honeypot risk, buy/sell tax simulation, ownership concentration, and liquidity.
- **Scam detection** — pig butchering, address poisoning, rug pulls, and mixer interactions.
- **Court-ready reports** — export as PDF, CSV, XLSX, or Markdown with fund-flow diagrams and evidence chains.

## Supported networks (23)

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
