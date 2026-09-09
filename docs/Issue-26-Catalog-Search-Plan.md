# Plan: catalog search #26

[Issue](https://github.com/anthoai97/livi-agent/issues/26). Implementation and validation notes: [Catalog-Search.md](Catalog-Search.md).

1. Verify `.env` read access, embedding model/dimensions/provenance/coverage. Reproduce yellow-sectional failure.
2. Extend existing catalog functions/contracts: original query, search purpose, room target/revision, persisted constraints. No invented budget/currency.
3. Retrieve: resolved category → top 80 text-ranked candidates; broad query → pipeline-owned pgvector index + bounded text candidates for unindexed products. Hydrate registry; match requested constraints. No added catalog exclusions; keep L-shaped products.
4. LLM attribute check → rank → eight cards by default. Actual asset color ≠ retailer color option. Preserve target, exclusions, follow-ups, saved cards; honest pagination.
5. Distinguish backend/model failure from empty matches. Sanitized diagnostics, cancellation, timeouts. Validate catalog/tool/pgvector tests, `pnpm check`, original prompt against live data; browser check if UI changes.

Four PRs via `gh stack`: contracts/diagnostics → category retrieval → vectors → ranking/follow-ups/validation. Pipeline owns index maintenance. Replacement execution: [#27](https://github.com/anthoai97/livi-agent/issues/27).

## Unresolved questions

None.
