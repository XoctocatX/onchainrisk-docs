# Webhooks

OnChainRisk delivers watchlist alerts to your backend via signed HTTP POST. Email and Telegram are alternative channels; webhooks give you full programmatic control over routing.

---

## 1. Setup

Register your webhook URL once at the account level via `PATCH /api/notifications/settings`:

```bash
curl -X PATCH https://api.onchainrisk.io/api/notifications/settings \
  -H "Authorization: Bearer ocr_live_PLACEHOLDER" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_enabled": true,
    "webhook_url": "https://your-backend.example.com/onchainrisk-webhook",
    "webhook_secret": "your-shared-secret-min-32-chars"
  }'
```

Then on each watchlist item, set `notify_webhook: true` to enable webhook delivery for that address.

```bash
curl -X POST https://api.onchainrisk.io/api/watchlist \
  -H "Authorization: Bearer ocr_live_PLACEHOLDER" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xYourAddress",
    "network": "eth",
    "notify_webhook": true
  }'
```

Test delivery: `POST /api/notifications/test` triggers an alert through every enabled channel.

---

## 2. Payload sample

```http
POST https://your-backend.example.com/onchainrisk-webhook
Content-Type: application/json
X-Signature-256: sha256=<hex_hmac_sha256_signature>
```

The signature is computed as HMAC-SHA256 over the raw JSON request body using your configured `webhook_secret`. See [§3 HMAC SHA-256 signature verification](#3-hmac-sha-256-signature-verification) below for verifier code in Node and Python.

```json
{
  "type": "watchlist_alert",
  "alert_id": 12345,
  "watchlist_id": 678,
  "address": "0xYourAddress",
  "network": "eth",
  "alert_type": "incoming",
  "tx_hash": "0xabc...",
  "explorer_url": "https://etherscan.io/tx/0xabc...",
  "value": "1.234",
  "timestamp": 1777800000,
  "data": {
    "address": "0xYourAddress",
    "network": "eth",
    "alertType": "incoming",
    "tx": {
      "hash": "0xabc...",
      "value": "1.234",
      "from": "0x...",
      "to": "0xYourAddress"
    },
    "tx_hash": "0xabc...",
    "explorer_url": "https://etherscan.io/tx/0xabc..."
  }
}
```

The exact body is whatever the alert pipeline produced (`type`, `address`, `network`, `tx_hash`, `value`, `alert_type` are stable; nested `data.*` fields evolve).

**Always parse defensively.** Check for the fields you need; do not assume the shape is closed.

---

## 3. HMAC SHA-256 signature verification

Every webhook delivery includes:

```
X-Signature-256: sha256=<hex>
```

Compute HMAC-SHA-256 over the **raw request body bytes**, keyed with your `webhook_secret`. Compare hex-encoded result to the header value (after stripping the `sha256=` prefix). Use a **constant-time** comparison.

### Node.js (verbatim — runnable)

```js
import crypto from 'node:crypto';

/**
 * Verify an OnChainRisk webhook signature.
 *
 * @param {Buffer|string} rawBody - exact request body bytes (NOT re-stringified JSON)
 * @param {string} signatureHeader - value of X-Signature-256 header
 * @param {string} secret - webhook_secret you configured
 * @returns {boolean}
 */
export function verifyOnChainRiskSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Length-mismatch must short-circuit BEFORE timingSafeEqual (it throws otherwise).
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(provided, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}
```

The snippet above is the complete verifier — drop it into your project as-is. For a smoke check, build a known-good signature with the same secret over a known body and assert equality before deploying to production.

### Python

```python
import hashlib
import hmac

def verify_onchainrisk_signature(raw_body: bytes, signature_header: str, secret: str) -> bool:
    """Verify OnChainRisk X-Signature-256 header.

    raw_body: bytes — the exact request body, NOT re-encoded JSON
    signature_header: e.g. "sha256=abcd1234..."
    secret: your webhook_secret
    """
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    provided = signature_header[len("sha256="):]
    expected = hmac.new(
        secret.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(provided, expected)
```

### Common verification mistakes

- **Re-stringifying the JSON.** If your framework parses the body before you can read it raw, the bytes you sign over may differ from what we signed. Capture raw bytes (Express: `express.raw({ type: 'application/json' })`; FastAPI: `Request.body()`; Flask: `request.get_data()`).
- **Non-constant-time comparison.** Don't use `===`. Use `crypto.timingSafeEqual` (Node) or `hmac.compare_digest` (Python).
- **Forgetting the prefix.** Strip `sha256=` before hex-comparing.

---

## 4. Latency

Watchlist cron fires every **5 minutes** (`*/5 * * * *`). Worst-case latency from an on-chain confirmation to webhook delivery is therefore **~5 minutes**, plus your network RTT.

This is **not real-time streaming**. We do not push the moment a transaction confirms; we poll on a 5-minute cadence and deliver fresh alerts in the next cycle.

Per-address per-run cap: **50 new transactions** per cron run (`MAX_NEW_TXS_PER_RUN`). Addresses producing >50 txs in 5 minutes are exchange-grade and almost certainly want daily-digest mode (`PATCH /api/notifications/settings { "daily_digest": true }`).

---

## 5. Delivery semantics — important caveats

### Single attempt today

Each alert is delivered **exactly once per cron run**. If your endpoint:
- returns a non-2xx response,
- times out,
- is briefly unreachable,

the alert is logged on our side as failed (in `console.error`) and **not retried**. The watchlist alert row records the delivery attempt; subsequent cron runs will deliver any **new** transactions for the same watchlist item, but the missed alert will not be re-sent.

### Recommended client-side mitigation

Until we ship retries, your handler should be tolerant:

1. **Return 2xx fast.** Acknowledge receipt, then process. If your processing might fail or take >5 seconds, accept the webhook into a queue (SQS, Redis, your DB) and process from the queue with your own retry semantics.
2. **Idempotency.** Use `alert_id` (or `data.tx_hash` + `address`) as a dedupe key. Even though we send each alert once, your queue may replay during your own retries.
3. **Health monitoring.** Watch your `/onchainrisk-webhook` endpoint's success rate; a failed webhook today is a **lost** alert.

### Roadmap

Webhook retries (3 attempts with exponential backoff, dead-letter visibility on `/api/alerts`) are planned hardening, not currently shipped. Track `capability-matrix.md`.

---

## 6. Channel selection

A watchlist item can deliver to email, Telegram, webhook, or any combination. Per-item flags:

```json
{
  "address": "0x...",
  "network": "eth",
  "notify_email": true,
  "notify_telegram": false,
  "notify_webhook": true
}
```

Account-level toggles in `PATCH /api/notifications/settings`:
- `email_enabled` (default `true`)
- `telegram_enabled` + `telegram_chat_id`
- `webhook_enabled` + `webhook_url` + `webhook_secret`
- `daily_digest` — collapses email alerts into one daily summary (webhooks are **always instant**, even with `daily_digest=true`)

---

## 7. Headers reference

| Header | Value | Notes |
|---|---|---|
| `Content-Type` | `application/json` | Always |
| `X-Signature-256` | `sha256=<hex>` | Present when `webhook_secret` is set; absent if you didn't set one. **Strongly recommend** setting one. |

We do not currently send `User-Agent`, `X-OnChainRisk-Event`, or other custom headers. Filter by request body shape (`type` field).

---

## 8. Test delivery

```bash
curl -X POST https://api.onchainrisk.io/api/notifications/test \
  -H "Authorization: Bearer ocr_live_PLACEHOLDER"
```

Triggers one alert through every enabled channel. Use this to verify your webhook endpoint is reachable and your signature verifier accepts the payload.

---

## See also

- `investigation-workflow.md` — full end-to-end flow including watchlist setup; also contains an inlined Node end-to-end snippet.
- `capability-matrix.md` — what's production vs roadmap, including webhook retries.
