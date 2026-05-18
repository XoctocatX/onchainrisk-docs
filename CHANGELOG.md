# Changelog

User-visible changes to the OnChainRisk public API. Newest first.

This changelog only covers the public API contract: endpoints, request and
response shapes, status codes, error codes, and supported networks.
Internal implementation, infrastructure, and tooling changes are not
listed here.

## 2026-05-18 - Structured `risk_evidence` on `/api/v1/check`

Each entry in `riskReasons` now includes a structured `evidence` array surfacing the underlying observation (OSINT match, internal label, pattern predicate, counterparty interaction) behind the reason. Empty array when no structured evidence is available. No change to `riskScore`, `riskLevel`, `riskContributions`, `riskWeights`, or scoring math.

Phase 1 populates structured evidence for floor-level reasons first; component reasons may return `evidence: []`.

`observedAt` is the analysis/scorer timestamp, not the original source publication or label-added timestamp.

## 2026-05-18 - Deep-analysis network enum on `/api/v1/check/deep`

`POST /api/v1/check/deep` now declares its supported network enum in OpenAPI:

`eth, arbitrum, optimism, base, polygon, avalanche, linea, zksync, scroll, celo, cronos, fantom, moonbeam, polygon_zkevm`

Unsupported networks now fail fast at the Worker boundary with `422 DEEP_ANALYSIS_UNSUPPORTED_NETWORK` before any upstream analysis call. This does not change the supported network set, pricing, or successful response shape.

## 2026-05-18 - Tron now supported on `/api/v1/token/check`

Tron token contracts are now accepted on:

- `POST /api/v1/token/check`
- `POST /api/v1/token/check/stream`
- `POST /api/v1/token/reports`

### Enum widening

The `network` enum on `/api/v1/token/check` is now:
`eth, bsc, arbitrum, optimism, base, polygon, avalanche, linea, zksync, tron`
(10 networks).

### Tron-specific result shape

Tron honeypot detection is **honeypot-only**. The following fields are
intentionally `null` for `network=tron`:

- `tokenScore` (security-category scoring requires EVM JSON-RPC)
- `topHolders` (holder enumeration requires EVM JSON-RPC)
- `tokenMeta` (name/symbol/decimals/totalSupply requires EVM JSON-RPC)

The `honeypot` object follows the same `honeypot.status` enum contract
introduced 2026-05-18:

- `status='ok'` — 15 measurable fields populated (`buyTax`, `sellTax`,
  `isHoneypot`, etc.)
- `status='unable_to_verify' | 'not_supported' | 'no_data'` — all
  measurable fields are `null`; `reason` is populated

### Billing semantics (unchanged from 2026-05-18 status-enum release)

- Tron `status='ok'` save: charged 1 credit + `token_reports` row +
  `usage` row.
- Tron non-ok save: **not charged**, no row, response `charged: false`.

### Scroll remains unsupported

`network='scroll'` still returns `422
NETWORK_NOT_SUPPORTED_FOR_TOKEN_CHECK` on `/api/v1/token/check`. Scroll
enablement is deferred until the upstream honeypot detector ships
scroll support.


## 2026-05-18 - Explicit `honeypot.status` enum on `/api/v1/token/check`

The `honeypot` field returned by `POST /api/v1/token/check` (and the
streaming variant `/api/v1/token/check/stream`) now carries an explicit
verification status. Save-time billing on `POST /api/v1/token/reports`
is gated on this status.

### New `honeypot.status` enum

- `ok` — verification succeeded; all 15 measurable fields populated.
- `unable_to_verify` — provider or analyzer error during the run.
- `not_supported` — honeypot detection is not available for this
  network/setup.
- `no_data` — no on-chain DEX pair found, or the contract is
  inconclusive.

### New `honeypot.reason` enum (only when status != "ok")

- `provider_rate_limited`
- `provider_error`
- `analyzer_error`
- `network_not_supported`
- `no_data`

### IMPORTANT — `isHoneypot === null` means UNKNOWN

For all non-ok statuses, `isHoneypot` is `null` (and so are the 14
other measurable fields). **Treat `isHoneypot === null` as
"unknown" — NOT as "not a honeypot".** Older client code that does:

```js
if (data.honeypot.isHoneypot) { /* danger */ }
else                          { /* safe */ }   // ← WRONG for null
```

must be updated to check status first:

```js
if (data.honeypot.status !== "ok") { /* unknown — handle separately */ }
else if (data.honeypot.isHoneypot) { /* danger */ }
else                               { /* safe */ }
```

### Billing change

Saving a token report (`POST /api/v1/token/reports`) is now charged
only when `honeypot.status === "ok"`. Non-ok statuses return a 200
response with `charged: false` and a structured echo of
`honeypot.{status, reason}`; no quota or credit is consumed and no
report row is created.

The response now always carries a `charged: true|false` field on
every save path (ok, duplicate-of-existing-save, non-ok).

### Legacy shape compatibility

Clients that send the pre-2026-05-18 honeypot shape (no `status`
field, `isHoneypot` as a boolean) continue to be saved and charged
under a `legacy_ok` classifier branch. **This compatibility branch
will be removed after 2026-06-17.** Update clients to read
`honeypot.status` before then.

### Out of scope for this release

- Dashboard rendering of the 4 status states ships separately in a
  follow-up release (next few days). Until then the dashboard may
  show a generic message on non-ok statuses.
- The `tron` and `scroll` networks remain outside the
  `/api/v1/token/check` supported set. Tron re-enablement is gated
  on the next release after the dashboard renderer ships.

## 2026-05-17 - Ranked `riskReasons` for `/api/v1/check`

The `POST /api/v1/check` response now includes a `riskReasons` array
that explains how the `riskScore` was reached. Each entry is either a
score-floor reason or a per-component reason, ranked by impact.

### Added response field

- `riskReasons`: array of structured reasons. Empty when `riskScore`
  is `null` or no signal exceeded the minimum impact threshold.

Each entry has:
- `code`: stable machine-readable identifier from a locked enum.
- `kind`: `floor` (an override floor was applied) or `component`
  (a non-zero per-component contribution to the base score).
- `severity`: `critical`, `high`, `medium`, or `low`. `critical` is
  reserved for sanctioned, exploit, and scam floor reasons.
- `title`: short English label for display.
- `templateKey`: namespaced i18n key (`reason.floor.<code-suffix>` or
  `reason.component.<code>`).
- `description`: short stable English explanation, may include
  integers (e.g. the floor minimum that was applied).
- `impactScore`: integer 0-100. For floors, the minimum the floor
  enforced. For components, the honest contribution to the base
  score before any floor.
- `supportingFlags`: for floor reasons, the matching subset of
  `flags`. For component reasons in this version, always an empty
  array.

### Order

`riskReasons` is sorted deterministically:
1. `impactScore` descending,
2. `kind` ascending (`floor` before `component`),
3. `code` ascending alphabetical.

### Compatibility

- `riskScore`, `riskLevel`, `riskContributions`, `riskWeights`,
  `riskConfidence`, `riskConfidenceDetails`, `flags`, `patternFlags`,
  and `patternFlagDetails` behavior did not change.
- Clients that ignore `riskReasons` see no change.
- Older servers may omit the field entirely - clients should default
  to `[]` when absent.

### Notes

`riskReasons` is the bridge between `riskScore` (final value, may be
boosted by an override floor) and `riskContributions` /
`riskWeights` (per-component pre-floor breakdown). When a floor
reason appears in `riskReasons`, it explains the gap between the
weighted-sum of contributions and the final score.

## 2026-05-16 - 3-tier `riskConfidence` for `/api/v1/check`

The `riskConfidence` field on the `POST /api/v1/check` response has
been widened from a 2-tier enum (`high`, `low`) to a 3-tier enum
(`high`, `medium`, `low`). A new structured field
`riskConfidenceDetails` is included alongside.

### Behavior change

- `riskConfidence` can now return `medium` in addition to the previous
  `high` and `low`.

### Added response fields

- `riskConfidenceDetails`: structured explanation of the confidence
  tier with the following keys:
  - `tier`: `high` | `medium` | `low` (same value as `riskConfidence`).
  - `completeness_pct`: fraction of reported transaction history
    actually fetched, 0-100, or `null` when the upstream provider does
    not expose a reliable total.
  - `reasons`: list of public-contract identifiers explaining which
    data signals contributed to the tier. Allowed values:
    `tx_count_coverage_subset`, `tx_count_coverage_approximate`,
    `tx_count_coverage_unknown`, `tx_fetch_incomplete_limit_cap`,
    `tx_fetch_incomplete_api_error`, `token_flow_incomplete`,
    `funded_by_approximate`, `funded_by_unavailable`,
    `score_unavailable_low_completeness`. The list is alphabetically
    sorted, deduplicated, and is empty when the tier is `high`. A
    `low` tier may also include medium-level reasons - clients should
    render the full list rather than only the most severe entry.

### Compatibility

- `riskScore` behavior did not change.
- `riskLevel` behavior did not change.
- Clients that previously assumed `riskConfidence` was exactly one of
  `high` or `low` should be updated to also handle `medium`. The
  recommended fallback is to treat `medium` the same as `low` for
  alerting purposes and the same as `high` for display.
- `riskConfidenceDetails` is optional and may be `null` on older
  responses. Clients that do not need the breakdown can ignore it.

### Notes

A `low` confidence tier does not mean the score itself is
inaccurate - it means at least one input signal was incomplete or
unavailable. When the score itself is unavailable (returned as
`null`), `riskConfidence` will be `low` and `reasons` will include
`score_unavailable_low_completeness`. We surface the confidence even
in that case so clients can render a clear "score unavailable,
confidence low" state.

## 2026-05-15 - Risk explainability fields for `/api/v1/check`

The `POST /api/v1/check` response now includes two additive fields that
help explain how the risk score is composed.

### Added response fields

- `riskContributions`: per-component risk contribution scores from 0 to 100.
- `riskWeights`: effective per-component weights used for this scoring run.

### Compatibility

- `riskScore` behavior did not change.
- `riskLevel` behavior did not change.
- Existing integrations do not need to change anything.
- The new fields are additive and can be ignored by clients that do not use them.

### Notes

For externally owned addresses, the contract-risk component is not
applicable and its weight is shown as `0`.

The final `riskScore` may differ from a simple weighted sum when
high-risk signals require a minimum score.
