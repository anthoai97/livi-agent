# Catalog search (#26)

`search_catalog` embeds the query and returns eligible indexed products ordered by cosine distance. Search is read-only; selected-product replacement is separate (#27). There is no attribute-validation model, reranking, text-search fallback, or supplementation from unindexed products.

## Search behavior

- Search text uses the tool query, then the original user message, then supplied color/style/material/category. Empty text fails with `invalid_arguments`.
- All searches join `pipeline.asset_embeddings` to `pipeline.design_asset_registry` by asset UUID. Shoppable/non-deleted eligibility and explicit category, color, style, material, dimension, USD price, and exclusion filters apply before pagination. Product ID breaks distance ties.
- General discovery works without Studio. Replacement searches require an unambiguous target from the original planning snapshot and retain its object ID, design ID, and revision. Follow-ups preserve that target through attachment changes.
- Product snapshots, intent, target, constraints, and pagination metadata persist in the transcript. Reopening chat renders saved cards without querying again.
- Similarity does not guarantee every requested attribute matches. `color` describes the actual asset; `availableColors` lists retailer options. The color filter accepts either, so a match may describe an option rather than the displayed asset.

## Prices and images

Registry prices use USD: positive finite dollar amounts become integer cents; missing, zero, or invalid prices remain unavailable. Price bounds default to USD; other currencies are rejected. Search does not infer a budget from room context. Old cards with null prices require a new search.

Images resolve from the public `livinit-storage-prod.s3.us-east-2.amazonaws.com` bucket, encoding literal `+` characters in paths. Saved S3 references resolve locally; other S3 buckets remain unresolved. Stable HTTP(S) URLs pass through.

## Pagination and follow-ups

- `limit` defaults to 6 (range 1–20). `offset` applies within filtered vector order. Fetching `limit + 1` rows provides lookahead; `nextOffset` advances by the returned count.
- `show_more` preserves constraints, excludes shown products, and retains the prior starting offset. Do not combine growing exclusions with `nextOffset`, which would skip products.
- `cheaper` and `smaller` tighten bounds, preserve intentional exclusions and currency, and reset exclusions of previously shown products.
- Follow-ups rerun embedding and retrieval. `exhausted` means no further matches under current filters/exclusions, not an empty catalog. Requests do not share a stable database snapshot.
- `candidateCount` includes lookahead, `candidateLimit` is `limit + 1`, and `truncated` indicates a lookahead row exists.

## Configuration and diagnostics

Set `CATALOG_DATABASE_URL` and `GEMINI_API_KEY`. Embedding uses `gemini-embedding-2-preview`, 768 dimensions, and query prefix `task: search result | query: `. Model changes require coordinating the adapter and rebuilding the pipeline-owned index. `GEMINI_MODEL` does not configure catalog embedding.

Embedding has a 30-second deadline; each database request has an eight-second deadline. These are stage limits, not a total chat deadline. Database connections are read-only; cancellation destroys an active checked-out connection.

Errors distinguish `query_failed`, `unauthorized`, `model_failed`, `timeout`, and `cancelled` from successful empty results. Missing Studio context is a separate preflight failure.

`LIVI_DEBUG=1` logs readable search and embed/retrieve steps with timestamps, timings, counts, pagination, and safe error codes. It omits tracing IDs, raw queries, SQL, catalog facts, provider responses, and credentials. Preflight failures and `get_product_details` may have no search-stage logs.

## Implementation

[Tools and targets](../packages/decorator-agent/src/studio-tools.ts) · [Vector SQL](../livi-server/src/catalog-postgres.ts) · [Embedding](../livi-server/src/catalog-models.ts) · [Follow-ups and deadlines](../packages/decorator-agent/src/catalog.ts)
