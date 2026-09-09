# Plan: catalog search #26

[Issue](https://github.com/anthoai97/livi-agent/issues/26). Current behavior and source evidence: [Catalog-Search.md](Catalog-Search.md).

## Revised scope

1. Preserve original query, search purpose, target/design/revision, explicit constraints and room-mutation safeguards.
2. Embed every search query using the existing pipeline-compatible model. Retrieve eligible indexed registry products by pgvector cosine distance; apply explicit SQL filters before pagination. No category/text route or unindexed supplementation.
3. Return eight products by default in vector order. Hydrate images using the web-pipeline public S3 URL convention and prices with the user-selected USD default. Remove attribute validation, evidence assessment and reranking code.
4. Use conventional filtered-result offsets and a one-row lookahead. `show_more` excludes shown IDs and retains the prior starting offset (normally zero); refinements reset traversal while preserving intentional exclusions and tighter bounds. Persist saved cards and target.
5. Keep safe embedding/retrieval stage diagnostics, cancellation and deadlines. Check ordering, filters, pagination, metadata and tool safeguards with targeted tests and required workspace checks.

Pipeline owns the existing index. Datasource/description improvements are deferred. Unindexed products are outside this retrieval path. Replacement execution remains [#27](https://github.com/anthoai97/livi-agent/issues/27).

The original four-stage contracts → category → vectors → ranking plan was implemented in stacked drafts, then superseded by this simplified scope. It is not the current retrieval contract.

## Unresolved questions

None.
