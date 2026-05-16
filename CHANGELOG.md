# Changelog

User-visible changes to the OnChainRisk public API. Newest first.

This changelog only covers the public API contract: endpoints, request and
response shapes, status codes, error codes, and supported networks.
Internal implementation, infrastructure, and tooling changes are not
listed here.

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
