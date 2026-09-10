# Catalog search (#26)

Catalog search embeds the query, retrieves the nearest eligible indexed products by cosine distance, and returns six products by default. It makes no catalog attribute-validation or reranking model call. Replacement execution belongs to #27.

## Current search flow

1. The chat model calls `search_catalog` with a query, purpose and explicit filters. The server preserves the admitted user message as `originalQuery`; a missing tool query falls back to that message. It does not infer a price budget from room context. Price bounds without a currency default to USD.
2. A new replacement search resolves its target from the original planning snapshot and saves the object ID, design ID and revision. Missing room evidence or an ambiguous/conflicting target stops that search before catalog access. General discovery can run without Studio. Follow-ups reuse their saved target through attachment changes.
3. The adapter embeds the search text using the pipeline's configured embedding model. If neither query nor original message is available, it builds search text from supplied color, style, material and category; empty search text fails with `invalid_arguments`. All searches use this vector route, including requests with an explicit category. Studio availability does not select a different retrieval strategy.
4. SQL joins `pipeline.asset_embeddings` to `pipeline.design_asset_registry` by asset UUID. Existing shoppable/non-deleted eligibility, explicit category, color, style, material, dimension, USD price and exclusion filters apply before pagination. Eligible rows are ordered by cosine distance, with a deterministic ID tie-breaker. Products without an existing embedding are not searched.
5. SQL fetches the requested page plus one extra row to determine whether more results exist. The adapter hydrates product facts and returns up to six products by default, preserving vector order. It does not validate attributes with a model, request evidence quotes, or rerank the results.
6. The tool saves product snapshots, original intent, target, constraints and retrieval/pagination metadata in the transcript. The chat model receives the result and writes its explanation. Reopening the chat renders saved cards without another catalog query. Search never executes a replacement.

Similarity is approximate evidence of relevance, not proof that every requested attribute matches. Explicit structured filters still restrict results, but other wording depends on existing embeddings and catalog facts. Improving the datasource and searchable descriptions is deferred. There is no text-search fallback or unindexed-product supplementation.

Replacement intent captured in the original request or action blocks erroneous room mutations before search. Recommendation/replacement searches block mutations for their operation, including after errors. Independent later move/rotate/remove requests continue to work.

Implementation references: [tool arguments and target resolution](../packages/decorator-agent/src/studio-tools.ts), [vector SQL and pagination](../livi-server/src/catalog-postgres.ts), [query embedding](../livi-server/src/catalog-models.ts), and [constraints, follow-ups and deadlines](../packages/decorator-agent/src/catalog.ts).

## Product images and prices

Product images use the public `livinit-storage-prod.s3.us-east-2.amazonaws.com` bucket, following `web-pipeline/lib/normalizeAssetUrl.ts`, with literal `+` characters encoded in object paths. Stable S3 references are preserved; saved cards resolve them locally without a fresh catalog query. S3 references for other buckets remain unresolved; existing stable HTTP(S) image URLs pass through.

Registry prices default to USD (explicit product decision). Positive finite dollar amounts become integer cents; missing, zero and invalid prices remain unavailable. USD bounds apply before pagination; other currencies are rejected without conversion. Previously saved results with null prices need a new search because their original numeric prices were not persisted.

`color` describes the actual asset. `availableColors` lists retailer options. The SQL color filter accepts a match in either field, so a matching retailer option does not prove this asset has that variant. Cards preserve this distinction; no subsequent model check removes retailer-option matches.

## Pagination and follow-ups

`offset` is a conventional result offset within the filtered vector ordering, with no former 80/160-candidate batch boundary. The default `limit` is six; callers can request 1–20. `pagination.nextOffset` advances by the actual returned count. The extra SQL row is a lookahead only and is not shown or consumed.

`show_more` keeps the search constraints and excludes already shown products. It retains the prior page’s starting offset (normally zero), so an explicitly skipped prefix stays skipped as shown products are removed from the eligible set. It does not combine growing exclusions with `nextOffset`, which would skip additional products. Unshown products, including the lookahead row, remain eligible. `cheaper` and `smaller` tighten the relevant bound, preserve intentional exclusions and reset traversal exclusions so previously shown products can qualify again. Existing tighter bounds and currency remain intact. Follow-ups rerun embedding and retrieval; they do not display a cached next page.

`exhausted` describes the current filters and exclusions: it is true when the query finds no extra row beyond the returned page. It does not mean the catalog has no products in other categories or colors, and it makes no claim about unindexed products. `retrieval.candidateCount` counts fetched rows including lookahead, `candidateLimit` is `limit + 1`, and `truncated` equals whether a lookahead row exists. Each request reads the current catalog; pagination is not a stable database snapshot cursor.

## Configuration, latency and diagnostics

Use `CATALOG_DATABASE_URL` and `GEMINI_API_KEY`. The embedding model is fixed to the verified pipeline configuration: `gemini-embedding-2-preview`, 768 dimensions, query prefix `task: search result | query: `. Changing pipeline embedding configuration requires coordinating this adapter and rebuilding the index in the pipeline. Livi never creates or maintains the index. `GEMINI_MODEL` does not select a catalog validator or reranker because those calls have been removed.

The user waits for chat planning, query embedding, database retrieval and the final chat response. Embedding has a 30-second deadline; each database request has an eight-second deadline. These are stage deadlines, not one overall chat deadline. The old potentially 160-product validation call no longer contributes latency.

Database requests use read-only connections. Caller cancellation stops waiting and destroys an active checked-out database connection. Errors distinguish `query_failed`, `unauthorized`, `model_failed`, `timeout`, `cancelled` and successful empty results. A timeout is a failed search, not evidence that no products exist. Missing Studio context is a separate failure from catalog retrieval.

With `LIVI_DEBUG=1`, catalog logs share a `requestId`. `catalog.search.start` records the vector strategy, purpose, offset, limit, exclusion count and query length. `catalog.search.complete` records duration, retrieved/returned counts and `hasMore`; retrieved count includes the lookahead row. `catalog.stage.start/complete/error` use `stage: embed` or `stage: retrieve` and report durations and deadlines. Safe PostgreSQL codes or HTTP statuses may identify backend failures. Raw queries, catalog facts, SQL, provider responses, connection strings and credentials are omitted. The `requestId` groups adapter search events; it is separate from the tool's `invocationId` and saved `searchId`. Preflight failures can occur before search-stage logging; `get_product_details` does not emit these search-stage events.

## Source and historical inspection (2026-09-09)

Pipeline checkout: `ab2af05bc875139591a16962173ffe120f8cf5d1`. Reviewed `rag_scope_assets.py`, `vector_store.py`, taxonomy and catalog/recommendation behavior. Pipeline deployment `.env` explicitly sets the same embedding model as its source default. The table has no per-row model metadata: configuration plus matching dimensions do **not** prove every row's model identity. Livi's simplified retrieval is not a reproduction of the pipeline's validation/ranking workflow.

Read-only database inspection at that time found:

- `pipeline.design_asset_registry` unions `pipeline_assets` and separately flagged decor records, with shared asset UUIDs.
- `asset_embeddings`: UUID key, legacy UID, `vector(768)`, category, content hash, updated timestamp; cosine HNSW index. All 3,912 embeddings had 768 dimensions and nonempty hashes; timestamps spanned 2026-05-18 through 2026-09-04.
- 4,994 shoppable undeleted registry products: 3,912 indexed and 1,082 unindexed. The simplified search covers indexed products only.
- `sofa_24` (`9b60afd1-654f-4e6b-bab0-80c5e2d5416e`): actual yellow, U-shaped, indexed.
- `sofa_1344` (`f7ea7d10-3848-4306-9e6b-635b239f414a`): actual Ash, L-shaped, unindexed; Yellow is a retailer option only. It is not eligible for the simplified vector-only search.

Earlier live checks confirmed a real user-query embedding returned 768 finite values and exercised read-only vector SQL. Earlier category, unindexed-supplementation and model-validation checks describe the previous implementation, not the current search. Real-model catalog attribute validation is no longer part of this scope.

After simplification, a live read-only check using the saved query embedding returned two pages of eight indexed products with no duplicates. The first query fetched nine rows, correctly reporting more results. A product lookup also confirmed USD 499.99 and a resolved HTTPS image URL. These three database operations took about 3.5 seconds together; no provider calls were made, so this is not an end-to-end chat latency measurement. Workspace checks and 28 server tests passed; one disposable-database test explicitly skipped because local PostgreSQL lacks pgvector. The live check exercised vector SQL against the configured catalog.
