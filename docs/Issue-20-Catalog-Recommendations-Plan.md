# Issue #20: catalog search and recommendation cards

Planning draft, 2026-09-09. Issue: https://github.com/anthoai97/livi-agent/issues/20.

## Outcome

The primary happy path is: “Can you replace the current sofa with a yello sectional sofa” → search for yellow sectional sofas → render matching catalog options in chat. Product selection and replacement execution come after the search/list feature.

Constrained browsing such as “Show smaller oak desks under $500” is also supported. Follow-ups retain the relevant constraints, and cards survive reconnect, conversation reopening, and server restart.

## Must-pass happy path: replacement request shows options first

Given an attached room with an identifiable current sofa and a catalog fixture containing multiple yellow sectional sofas:

1. The user sends the exact prompt: “Can you replace the current sofa with a yello sectional sofa”. Treat the obvious typo “yello” as “yellow”.
2. Recognize replacement intent as a request to discover candidate products first. Use the current sofa/room as context; do not stop at saying replacement execution is unsupported.
3. Search for products satisfying both yellow color and sectional-sofa identity. Keep the current object's type (sofa) separate from the desired product type (sectional). Normalize equivalent catalog labels such as `sectional_sofa` and `sectional`, but do not widen to sibling seating categories. Verify yellow against catalog color/variant facts, and do not silently broaden to any yellow sofa or any sectional.
4. Render a list of matching product cards with real IDs, images, available dimensions/prices, product links, and concise reasons. The assistant explains that these are replacement options; it does not claim the room changed or guarantee fit.
5. Leave the current sofa and room unchanged. Dispatch zero move, rotate, remove, add, or replace actions. In particular, never remove the current sofa as preparation for replacement.
6. Reopening the conversation restores the same options. Cards retain product IDs for the later selection flow. Enabled selection-to-replacement controls and replacement execution are deferred.

An ambiguous current sofa does not prevent browsing for yellow sectionals. Retain the exact placed-object ID when unambiguous; resolve an ambiguous replacement target before execution in the later issue. If the catalog has no matching products, explain that without relaxing color/type constraints. Fixture tests must supply real matching fixture records so the happy path proves that a list is rendered; live acceptance requires matching catalog data.

## Existing foundation

- Issue #19 is closed. Studio objects already carry a distinct catalog ID and nullable price; snapshots carry a nullable budget. Typed add/replace selections are admitted and persisted.
- `packages/decorator-agent/src/studio-tools.ts` owns the tool registry and system prompt. Extend `createStudioTools` and `studioSystemPrompt` in place.
- `packages/decorator-agent/src/decorator-session.ts` wires tools, room planning context, and the durable harness. Inject catalog access here from `livi-server/src/server.ts`.
- `services/transcript-provider.ts` already publishes a JSON transcript snapshot, including tool results. `livi-client/src/main.tsx` currently renders only user/assistant text.
- The companion backend has catalog detail/batch helpers in `backend/src/services/catalog_assets.py`, reading `pipeline.design_asset_registry`. Its `/catalog` routes currently expose wall finishes, not furniture search. The pipeline reader includes product IDs, names, category/style/color/materials, dimensions, price, image, and product links. This is source-code evidence; the deployed schema and permissions still need verification.

## Agreed catalog connection

Connect the Livi server to PostgreSQL using a standard PostgreSQL driver and parameterized SQL against `pipeline.design_asset_registry`. Initially, Supabase hosts this database. The user selected standard PostgreSQL access for portability during planning on 2026-09-09. Implement one server-only, read-only adapter with typed search/detail operations; no Supabase SDK or Data API dependency is needed for catalog queries.

Connection flow: chat prompt → decorator catalog tool → injected Livi server adapter → PostgreSQL connection pool → catalog registry → normalized tool result → saved transcript and cards.

- Read `CATALOG_DATABASE_URL` in `livi-server/src/main.ts`, and document a placeholder in `.env.example` when implementing. It contains database connection credentials, not a Supabase API key. Use verified TLS for the hosted connection; keep credentials out of browser configuration, transcript data, and logs.
- Construct one bounded connection pool per server process in `startLiviServer`, inject the adapter through `DecoratorSessionOptions` into the existing tool context, and close the pool during server shutdown and failed startup cleanup. Set connection/query timeouts and account for the total pool size across server instances. Tests inject a deterministic adapter without production credentials.
- Use a dedicated read-only database role with the schema/view and underlying read permissions required by the registry. Verify access through that role and enforce product visibility; do not use a database administrator account for application queries.
- Use the fixed, schema-qualified `pipeline.design_asset_registry` view with parameterized filter values and fixed or allowlisted sorting. Expose only bounded search and exact-ID detail reads through the adapter; the model cannot choose SQL, arbitrary tables, or write operations. Database access does not require exposing the schema through Supabase's Data API.
- Keep catalog setup optional for existing chat and Studio workflows. An absent URL produces a clear catalog-unavailable result; a malformed URL produces a configuration error. Database connection/query failures produce useful catalog errors. Do not fall back to invented products.
- Start with database filters and bounded ranking over matching candidates. Vector search is outside the first implementation slice and is not required to connect to the catalog.
- Use a PostgreSQL endpoint appropriate to deployment: a direct endpoint for the persistent Livi server when reachable, or a compatible pooled endpoint when needed. Keep driver settings compatible with the chosen pooling mode. See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

Keep SQL and the adapter contract portable. Moving to another PostgreSQL host should require minimal application changes if the registry schema is preserved; data, views, role grants, and image storage still need their own migration. Scaling work should be driven by query plans, indexes, bounded pagination, and connection usage, rather than a provider-specific client API.

Before implementing the production adapter, verify source dimension units/axes, currency provenance and price units, supported filter values, pagination, product visibility rules, and database permissions. Existing Python normalization substitutes zero for some missing prices/dimensions and must not be copied. Do not assume every price is USD or bypass the required access policy.

Concrete companion schema findings from `backend/supabase/migrations/20260810000100_design_asset_registry.sql` and `20260824000100_decor_soft_exclusion.sql`:

- The registry exposes `price` without a currency field. An authoritative currency mapping is required for constrained monetary searches; until available, normalized money is unknown. An unverified price must not satisfy “under $500.”
- The registry includes `is_decor_item` rows with explicit zero prices and no product links. Product search should exclude these non-purchasable entries rather than recommend them as free furniture.
- Existing registry access is granted to `service_role`, with anonymous/authenticated access revoked. Include a deployment grant step for the dedicated Livi read role: database CONNECT, USAGE on `pipeline`, and SELECT on `design_asset_registry`, `pipeline_assets`, and `decor_items`, with no write grants. The registry uses `security_invoker`, so underlying relation permissions and applicable row policies must be verified as well as SELECT on the view.
- Some source images use `s3://` URLs. Reuse an authorized image resolver and retain a stable image reference; expiring signed URLs must be renewable without rerunning the catalog search or changing saved product facts.

## Implementation sequence

Use `gh stack` for three dependent PRs when implementation begins. Catalog access is implemented in the Livi server.

### 1. Catalog contract, adapter, and read-only tools

- Implement the PostgreSQL adapter and its server-owned pool using `CATALOG_DATABASE_URL`. Query the existing registry with parameterized SQL and push supported hard filters into SQL before bounded ranking. Verify source column types and relevant query plans before choosing indexes.
- Define a browser-safe typed catalog product/result contract, exported through the existing contracts entrypoint. Include canonical catalog ID, name, nullable image/product URLs, nullable dimension facts with documented units, nullable money using `{ amountMinor, currency }`, and the available descriptive attributes.
- Add `search_catalog` and `get_product_details` to the existing registry. Inject catalog access through server/session options; keep credentials on the server. Catalog browsing works without an attached Studio; available room facts improve ranking.
- Handle natural-language replacement requests without an exact selected product by searching and presenting options first. Reuse the existing agent/tool flow; a replacement verb alone must not trigger a room mutation or an unsupported-action dead end.
- Do not copy the pipeline's layout-specific exclusion of L-shaped sofas/sectionals into catalog browsing. Verified yellow sectionals must remain eligible. An optimized placement model is not a prerequisite for showing a purchasable catalog product; future execution can check placement support separately.
- Validate requests and catalog responses at runtime. Enforce explicit category, style, color, material, dimension, and price constraints before ranking. Unknown facts cannot satisfy a hard constraint. Explain unsupported filters rather than silently dropping them. Compare money only in a verified matching currency; do not infer exchange rates.
- Rank matching results using stated preferences and available room context. Distinguish a room's total budget from a product spending limit; do not claim an exact remaining budget if existing prices are unknown.
- Produce concise reasons from verified matching facts. Return the same normalized product payload as model-visible tool content and typed result details, so cards and the response share their source facts.
- Return useful empty, unavailable, unauthorized, timeout, and malformed-response outcomes. Distinguish an exhausted catalog search from a bounded scan that found no matches. Support cancellation and bounded pagination.
- Keep catalog execution independent of Studio mutation dispatch. Update the system prompt to browse without room actions and avoid guaranteed-fit claims. Catalog descriptions are data, not instructions.

### 2. Durable recommendations and follow-up constraints

- Save a discriminated recommendation payload in completed tool-result `details`: normalized product snapshots, reasons, resolved constraints, search identity, pagination state, and relevant room/binding provenance. Reuse the existing harness/SQLite transcript; no separate card store or core persistence migration is expected.
- Reconstruct the active search and shown product IDs from durable results. A follow-up references its prior search and changes only specified constraints; the server merges/validates the changes. Avoid relying solely on the model to repeat every previous filter correctly.
- “Show more” retains filters and continues pagination, excluding previously shown IDs where possible. “Cheaper” uses an identified same-currency reference or asks for clarification; it retains the other constraints. “Smaller” uses an identified product and dimension, or asks for clarification when the comparison is ambiguous. Show the resolved comparison rather than inventing a threshold.
- Reset pagination when filters change. A new independent search starts a new search identity. Preserve explicit preferences but recompute room-derived assumptions if the attached design changes; avoid carrying a previous room's budget into a different design.
- Persist unsuccessful resolved searches sufficiently to support later refinements without losing constraints. An error does not advance successful pagination or mark unseen products as shown.
- Completed cards are historical snapshots: reopening does not fetch current prices or rerun searches. A new detail request can return newer facts as a new result. Interrupted read-only calls may safely retry; completed results must not produce duplicate cards. Preserve existing non-replay behavior for room mutations.

### 3. Chat cards and end-to-end validation

- Match the user's [UI reference](assets/catalog-recommendation-reference.png): a short assistant introduction followed by product cards within the chat response. Use a white/light-gray surface, generous rounded corners, a subtle shadow, a large image above the content, a bold product title, a short muted description, and a prominent purple price. Preserve the reference's purple accents and spacing in the existing chat UI.
- Apply this card design to multiple matching products, arranged in a wrapping row on wider screens and stacked on narrow screens. Use actual catalog product names so options are distinguishable. Include available dimensions and a concise recommendation reason without making the card dense.
- A top-ranked card may show a purple “Recommended” badge in the reference's badge position. Do not label it “Best fit” while placement fit is unverified. The reference's purple “Change sofa” action belongs to the later selection/replacement feature; omit it in this phase and retain the product link for browsing.
- Use concise introduction text such as “Here are yellow sectional sofas to consider for your room.” Do not use the reference's “Choose a replacement to update it” copy until that action is available. The reference image and its example price are visual guidance, not catalog data.
- Render only validated recommendation tool results alongside the existing chronological transcript. Use durable entry/tool-call identity for keys; do not append cards from transient events or show arbitrary raw tool JSON.
- Show product image with fallback, name, dimensions, formatted price/currency, product link, and reason. Label missing facts explicitly. Validate image/link protocols. Keep cards usable on narrow screens and with keyboard navigation.
- Keep the catalog product ID in card data for later typed selections. Omit Add/Replace controls until execution is supported.
- Check model response IDs and prices against the canonical results in focused scenarios. Make product facts in cards come directly from the saved result, never parsed from assistant prose.

## Acceptance checks

- Primary happy path: the exact “yello sectional sofa” replacement prompt yields multiple matching yellow-sectional cards from a seeded catalog, excludes wrong-color and non-sectional distractors, retains the current sofa, and emits zero Studio mutations. Verify card persistence and the absence of an enabled replacement action. Include an L-shaped sectional to catch accidental reuse of layout exclusions.
- Verify intent and typo interpretation with a real-model read-only scenario using controlled catalog data. Deterministic injected-provider tests prove tool, transport, persistence, and UI behavior; they alone do not prove natural-language understanding.
- Adapter fixtures: combined filters, strict price/dimension boundaries, unknown values, mixed currencies, unsupported filters, empty/exhausted results, pagination duplicates, authentication errors, timeout, and malformed catalog data.
- PostgreSQL integration: exercise the actual adapter against a disposable database with a representative registry view and restricted read role. Check parameterized filters, stable pagination, nullable facts, query failures, timeouts, and pool cleanup. Verify that the role can read required catalog data and cannot mutate it; mocked adapters alone do not establish SQL correctness or permissions.
- Decorator integration: initial search followed by cheaper/smaller/show-more; only intended constraints change, search state remains isolated by conversation, and browsing/error paths dispatch zero Studio mutations. Cover unattached/offline Studio and existing room-action regressions.
- Real SQLite/WebSocket integration: save cards, disconnect/reconnect, reopen the conversation, restart the server, and verify identical product snapshots with no duplicate results or completed-search reruns. Continue a follow-up after recovery.
- Extend `scripts/browser-smoke.ts` with deterministic catalog fixtures: matching product names/prices, missing-fact display, links, desktop/mobile cards, persistence, and no enabled Add/Replace controls. Keep its existing raw-tool-result hiding assertion.
- Capture desktop/mobile screenshots of the primary happy path and visually compare the cards with the saved UI reference, including multiple results, long names, and missing images/prices.
- Run focused decorator/server tests, `pnpm check`, and the browser smoke after building. Run an authorized live read-only catalog search/detail check once the source and credentials are configured. Fixture success alone does not establish production authorization or catalog correctness.

## First implementation slice

Implement server configuration, the bounded PostgreSQL pool, and the typed catalog adapter, then carry the primary yellow-sectional replacement request through search and persisted cards across the three PRs. Verify source mapping and read-role access along the way. Unknown currency remains explicit and does not block this unpriced search; authoritative currency mapping is required for price-constrained cases. Image resolution remains necessary for usable cards. Do not expand into placement, fit confirmation, selected-product execution, or Studio saves.
