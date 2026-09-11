# Livi decorator-agent capabilities

`@livi/decorator-agent` is a single decorator agent, not a multi-agent orchestrator. It chats, browses catalog products, and (with an attached Studio) edits one room.

## Always available

- Streamed chat with Gemini (`gemini-3.8-flash` by default)
- Saved conversations, Stop, reconnect, interrupted-chat recovery
- General interior-design Q&A without Studio
- No shell, filesystem, skills, extensions, or MCP

## Catalog (no Studio required)

Needs `CATALOG_DATABASE_URL` (PostgreSQL `pipeline.design_asset_registry`). If unset, catalog tools report unavailable.

| Tool | What it does |
| --- | --- |
| `search_catalog` | Vector search of shoppable products; filters for category, color, style, material, size, USD price |
| `get_product_details` | One product by catalog ID |

Search purposes: discovery, recommendation, replacement. Follow-ups: show more, cheaper, smaller. Results render as cards. Similarity is not attribute-validated; prices are USD only.

## Room edits (attached Studio required)

| Tool | What it does |
| --- | --- |
| `get_room_context` | Read current room / inventory |
| `move_object` | Absolute position in metres (+X right, +Y back, +Z up) |
| `rotate_object` | Yaw only: `[0, 0, radians]` |
| `remove_object` | Remove one placed instance; not reversible |
| `replace_object` | Swap a placed object with a product chosen on a recommendation card |

Named objects come from room inventory. Studio selection is optional. Studio owns save/validation; the agent sends one command and reports the saved/error result.

Replace flow: search → cards with “Replace with this” → `replace_asset` selection → `replace_object`. Product ID comes from the card, not the model.

You cannot add a new chair or sofa while keeping the old one. Search is browse-only. The only catalog-to-room action is replace. `add_asset` is accepted on the chat wire, but there is no add tool and Studio has no `add` command. A second piece must be added in Studio itself.

## Undo

- Move / rotate: reverse via `originalCommandId` of a saved action, if the object’s transform still matches
- Replace: “change it back” restores the previous catalog product from saved history
- Remove: cannot be restored
- Stale revision: refresh context and retry up to twice in the same request
- Interrupted room edits are never replayed

## Not supported

- Add / duplicate furniture
- Layout generation, layout options, apply-layout
- New designs / variants
- Materials, wall/floor/curtain color
- Pitch/roll rotation, camera-relative moves
- General undo/redo stack
- Budget-aware placement or fit checks
- Skills / placement guidebook

## Integration

Chat, catalog, and headless JSON Studio smoke exist. Real Studio editor/backend joint acceptance is still pending. Catalog browsing works without Studio; room mutations need a connected Studio on the origin allowlist.
