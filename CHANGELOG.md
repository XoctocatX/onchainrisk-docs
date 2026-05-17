# Changelog

User-visible changes to the OnChainRisk public API. Newest first.

This changelog only covers the public API contract: endpoints, request and
response shapes, status codes, error codes, and supported networks.
Internal implementation, infrastructure, and tooling changes are not
listed here.

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
