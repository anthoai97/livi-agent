# Livi decorator-agent capabilities

`@livi/decorator-agent` provides one conversational agent for catalog browsing and edits to an attached Studio room. Tool behavior below describes the current implementation; conversation guidance describes model instructions, not guaranteed wording.

## Chat

- Streamed Gemini responses; default model `gemini-3.8-flash`, configurable with `GEMINI_MODEL`.
- Saved conversations, Stop, reconnect, interrupted-chat recovery. Recovery does not authorize replaying room edits.
- Interior-design Q&A without Studio; model credentials/service access still required.
- No shell, filesystem, skill, extension, or MCP tools exposed to Livi.

Conversation guidance: for broad product requests, search immediately and show 5–7 options (six by default, fewer if unavailable). Ask one useful refinement question; retain known preferences. Use product display names and keep internal IDs out of replies unless explicitly requested. A clear product choice or room-edit request should proceed without extra discovery questions.

## Catalog

No Studio required. The default server uses `CATALOG_DATABASE_URL` for PostgreSQL; unset means catalog unavailable. Search also needs the configured query-embedding service. Listing brands and reading product details make no embedding API call.

| Tool | Behavior |
| --- | --- |
| `search_catalog` | Similarity-ranked products after explicit filters; six results by default, maximum 20 per page. Produces recommendation cards. |
| `list_catalog_brands` | Distinct searchable brand/store labels and product counts; default/maximum 20 per page. No product cards or recommendation-history changes. |
| `get_product_details` | One active, non-decor product by exact catalog ID; an embedding is not required. |

### Search and refinement

- Search reads active, non-decor rows from `pipeline.design_asset_registry` joined to non-null `pipeline.asset_embeddings` entries. Display names prefer `pipeline.pipeline_assets.catalog_name`, falling back to the registry name.
- SQL applies brand/store, category, color, style, material, width/depth/height, and price filters before similarity ordering and pagination. There is no later model validation or reranking; relevance, physical fit, and retailer stock are not verified.
- Category uses defined aliases. Color matches the recorded color **or** retailer color options; an option does not verify the placed asset's color. Color/style/material use case-insensitive full-value or token matching, not semantic matching. Missing required attributes fail their filters.
- Dimensions are metres; price bounds are integer minor units. Registry prices are treated as USD; other price-filter currencies are rejected, with no conversion.
- Purposes: discovery, recommendation, replacement. `show_more`, `cheaper`, and `smaller` retain saved constraints and replacement target. Cheaper/smaller require one identified product with a known price/dimension. Smaller needs an explicit comparison dimension unless exactly one dimension is known.

### Brand/store identity and availability

The `brand` filter uses the registry **`source`** field. Matching trims/collapses whitespace and ignores case, but requires the complete label. No substrings or inferred aliases: `Modway` and `Modway Furniture` are distinct. Cards retain the original label. A source can identify a retailer or brand; it is not a verified manufacturer and is not inferred from the product URL.

`list_catalog_brands` groups those normalized labels from searchable products with nonempty sources. Each entry contains `brand` (search key), `source` (original representative label), and `productCount`. Continue using `pagination.nextOffset` until `exhausted`. Counts ignore other product filters and do not represent stock.

Conversation guidance:

- “Show IKEA sofas” sets a brand filter; “like IKEA” is a descriptive query. These examples do not establish IKEA availability.
- “Try Article instead” starts a new search preserving other explicit constraints and the target. Supplying a new/conflicting brand with `followUp` is rejected; the same normalized brand is allowed.
- Answer availability questions from a successful listing. Read all pages before claiming absence or completeness. An empty filtered product search alone cannot establish brand absence.
- Correct earlier unsupported availability claims. If listing fails, say availability cannot be verified; do not invent brands or silently drop filters.

Source quality remains a data concern: cross-domain Walmart labels and `*_DSFabricsCIS` names need audit. This implementation does not rewrite sources.

## Room edits

Require an attached Studio with a compatible contract and an origin in `STUDIO_ALLOWED_ORIGINS`. Current contract: package `0.6.0`, protocol `1`. Targets resolve from room inventory; manual selection is optional.

| Tool | Behavior |
| --- | --- |
| `get_room_context` | Read current room/inventory; exact object, name/category query, or offset pagination. |
| `move_object` | Absolute position in metres: +X right, +Y back, +Z up, from floor front-left. |
| `rotate_object` | Absolute yaw `[0, 0, radians]`; preserves position/scale. |
| `remove_object` | Remove one placed instance. |
| `replace_object` | Replace a placed instance with a verified chosen catalog product. |
| `add_object` | Add a chosen catalog product; quantity defaults to 1, maximum 50. |
| `duplicate_object` | Create 1–50 copies of one placed instance, retaining the original. |
| `batch_room_edits` | Ordered move/rotate/remove/replace/add/duplicate edits in one atomic save; maximum 50 expanded operations, including quantities. |

Product choices can be typed or made through cards. Typed add/replace choices require an exact catalog ID from saved recommendations or a successful product-details lookup. Ambiguous names require clarification in chat; buttons are optional. Placement guidance asks the model to choose an explicit position/orientation from available room facts when the user omits one; this is not a fit guarantee.

Batch targets see preceding staged edits. Edits needing newly created IDs or unresolved replacement dimensions wait for a later model round. Studio validates and saves; a saved batch returns ordered per-edit results and one final snapshot/revision. Only a saved acknowledgement supports a success claim.

### Undo and recovery

- Direct undo supports saved moves, rotations, and replacements, subject to matching current state and valid history. Use `originalCommandId`; batch edits additionally require `originalEditIndex`. Reverse supported batch edits in reverse order.
- Remove/add/duplicate have no direct undo. A removed product can be verified and added as a **new instance**; the original instance and placement are not recovered.
- Known stale-revision rejection: refresh, replan the rejected operation/batch, retry at most twice per request.
- Unknown/no-reply outcomes may have saved: do not resend in the same request. An unknown batch blocks further edits in that request. Interrupted edits are not automatically replayed; a new explicit request can use fresh state.

## Limits and acceptance

No layout-generation/options API, new designs/variants, material or wall/floor/curtain editing, pitch/roll, camera-relative movement, general undo/redo stack, or budget/fit optimization. Rearranging existing furniture through supported moves/rotations is available.

Batch acceptance includes injected JSON smoke and a live companion-executor/API save-and-reload check; browser-driven, real-model Studio acceptance remains pending. See [batch verification](verification/57-batch-room-edits.md). Catalog brand checks include real-model tests with synthetic inventory and read-only listing against the configured database; these do not establish browser acceptance or live pgvector-search coverage.
