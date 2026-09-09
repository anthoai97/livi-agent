# Catalog search (#26)

Catalog recommendations are read-only. Replacement execution belongs to #27.

- Preserve the admitted user message as `originalQuery`, alongside the search query, purpose, original target object/design/revision and explicit constraints. Never infer a budget or currency from the room budget.
- A resolved category in an existing room uses text relevance and at most 80 registry candidates, bypassing embeddings. Category aliases normalize spaces, hyphens and plurals. No added model-availability or L-shaped exclusions.
- Broad discovery uses pgvector cosine retrieval from `pipeline.asset_embeddings`, hydrated by registry UUID, plus up to 80 text-ranked unindexed registry products. The combined candidate limit is 160. Existing shoppable/non-deleted registry filters remain.
- The configured Gemini validator receives the whole hydrated candidate pool before pagination. It checks explicit attributes and returns one verdict and score per candidate. Matching verdicts require exact quotes from catalog facts; invalid/omitted/duplicate IDs, unsupported evidence, or malformed scores fail the search. Eight cards are returned by default.
- `color` describes the actual asset. `availableColors` lists retailer options; an option does not prove this asset has that variant. The first card reason preserves this distinction.
- Recommendations save product facts, retrieval metadata, constraints and target in the transcript. Follow-ups retain the original target and binding through detachment or attachment changes. They do not execute a replacement. Current-product and user exclusions remain intentional; traversal exclusions reset for cheaper/smaller refinements. Existing tighter bounds and currency remain intact.
- Replacement intent captured in the original request or action blocks erroneous room mutations before search. Recommendation/replacement searches block mutations for their operation, including after errors. Independent later move/rotate/remove requests continue to work.

## Pagination

`offset` indexes the current bounded ranked candidate batch: 0–79 for category/text retrieval, 0–159 for broad vector retrieval. SQL never applies this offset separately to the two sources. A page at a batch boundary may be short: use `pagination.nextOffset` (offset plus actual returned count), not offset plus requested limit. Out-of-batch offsets fail with guidance to use `show_more`.

`show_more` carries shown, rejected and offset-skipped candidate IDs in traversal state; it can advance even when all 80 candidates in a batch fail validation. Unshown matching candidates remain eligible. `exhausted` is false when an additional retrieval candidate exists, even if this batch returned no matches. `retrieval.truncated` means only a bounded batch was examined, not that the whole catalog lacks matches. Each request reranks current catalog facts; this is not a stable database snapshot cursor.

## Configuration and diagnostics

Use `CATALOG_DATABASE_URL`, `GEMINI_API_KEY`, and optional `GEMINI_MODEL` (validator; default `gemini-3.5-flash-lite`). The embedding model is fixed to the verified pipeline configuration: `gemini-embedding-2-preview`, 768 dimensions, query prefix `task: search result | query: `. Changing pipeline embedding configuration requires coordinating this adapter and rebuilding the index in the pipeline. Livi never creates or maintains the index.

Database requests use read-only connections and an eight-second deadline; model requests have a 30-second deadline each. Caller cancellation stops waiting and destroys an active checked-out database connection. Errors distinguish `query_failed`, `unauthorized`, `model_failed`, `timeout`, `cancelled` and successful empty results. Internal diagnostics include only stage plus safe PostgreSQL code or HTTP status, never SQL, connection strings, provider messages or credentials. A backend/model failure is not a reason to change the requested color or style.

## Verified source and live evidence (2026-09-09)

Pipeline checkout: `ab2af05bc875139591a16962173ffe120f8cf5d1`. Reviewed `rag_scope_assets.py`, `vector_store.py`, taxonomy and catalog/recommendation behavior. Pipeline deployment `.env` explicitly sets the same embedding model as its source default. The table has no per-row model metadata: configuration plus matching dimensions do **not** prove every row's model identity.

Read-only database inspection found:

- `pipeline.design_asset_registry` unions `pipeline_assets` and separately flagged decor records, with shared asset UUIDs.
- `asset_embeddings`: UUID key, legacy UID, `vector(768)`, category, content hash, updated timestamp; cosine HNSW index. All 3,912 embeddings have 768 dimensions and nonempty hashes; timestamps span 2026-05-18 through 2026-09-04.
- 4,994 shoppable undeleted registry products: 3,912 indexed and 1,082 unindexed. Pipeline warmup eligibility explains why unindexed supplementation matters.
- `sofa_24` (`9b60afd1-654f-4e6b-bab0-80c5e2d5416e`): actual yellow, U-shaped, indexed.
- `sofa_1344` (`f7ea7d10-3848-4306-9e6b-635b239f414a`): actual Ash, L-shaped, unindexed; Yellow is a retailer option only.

Validation evidence:

- `pnpm check` passes. Decorator suite: 81 passing tests. Server suite: 27 passing tests, one explicit local pgvector skip. No UI changes.

- Disposable PostgreSQL tests cover read-only permissions, text ranking, 80-candidate limits, pagination and category aliases. A pgvector integration test explicitly skips when the local extension is unavailable (this machine's PostgreSQL 14 lacks it).
- Synthetic model tests cover whole-pool validation, ranking candidate 80 first, malformed/fabricated evidence, cancellation, unindexed offset 80, and advancing past 80 rejected candidates.
- Tool tests cover original prompt/target persistence, explicit exclusions, refinement bounds, ambiguous/conflicting targets, and erroneous mutations before/after replacement searches while allowing independent later edits.
- Real user-query Gemini embedding returned 768 finite values. Live read-only vector SQL exercised indexed and unindexed products using an injected embedding/local validator.
- Original prompt “Can you replace the current sofa with a yello sectional sofa” passed live DB integration with **faux chat and a local validator**: unselected synthetic target `current-sofa-1`, revision `1`, two category candidates, no invented budget/currency despite a room budget, correctly qualified yellow/Ash facts, and zero room commands.
- Full live real-model attribute validation remains unverified. Automatic approval review rejected sending catalog facts to Google. The root prepared the exact two-product payload for user approval; all checks above avoid that egress.
