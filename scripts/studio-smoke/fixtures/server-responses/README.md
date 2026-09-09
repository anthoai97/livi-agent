# Studio server response fixtures

`f0fee311-38cf-4b66-b11b-e21b76134c9d.json` is the room response supplied by the user on 2026-09-09, design revision 2. It preserves the supplied fields and values, including six placed entities, string prices, absent currency fields, and `studio_state: { "schema_version": 1 }`.

This is raw `studio-design.v2` server data, not the agent's `StudioSnapshot` or a directly runnable `smoke:studio --room` fixture. A complete adapter mapping must be verified before using it for room-action smoke tests.

## Price and budget expectations

The user confirmed that missing currency defaults to USD. The paired `.expected-money.json` records the intended mapping for future adapter regression tests:

- Preserve the placed entity key as object identity and the asset ID as catalog identity.
- Interpret these `price_amount` strings as USD major units and convert to integer cents; the sofa's `"5400"` becomes `{ "amountMinor": 540000, "currency": "USD" }`.
- Default only missing currency; retain explicitly supplied currencies and use their own minor-unit precision.
- Currency defaulting must not invent a missing amount. This response has no budget amount, so the expected budget remains `null` (unknown).

The source proves that prices exist but currencies are absent. The Studio adapter now defaults missing product currency to USD and converts saved `studio_state.custom_budget_value` to USD minor units. Explicit product currencies retain their own precision. Missing amounts remain unknown.

Verified this response through the Studio parser and the actual `studioSnapshotFromCurrent` adapter: all six products match the expected USD values, including the sofa at $5,400; budget remains null because this response supplies no amount. The existing 17 Studio execution contract tests and TypeScript check also pass. These checks do not assert real-model wording or deployment status.
