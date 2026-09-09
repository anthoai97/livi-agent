# Orchestrator capabilities and decorator plan

Source inspected: 2026-09-08, pipeline `ab2af05`, decorator `77dc712`.

## Pipeline capabilities

The orchestrator defines 15 routes:

| Route | Behavior |
| --- | --- |
| `NEW_DESIGN` | Select furniture, generate/fix/refine layouts, and produce three design variants. |
| `MOVE_ASSET` | Reposition and rotate existing furniture with layout repair. |
| `CHANGE_ASSET` | Replace identified furniture with a selected catalog product. |
| `RECOMMEND_ASSET` | Search and rank products; show cards without changing the room. |
| `ADD_ASSET` | Place selected products or duplicate an identified existing product. |
| `REMOVE_ASSET` | Remove identified furniture. |
| `LAYOUT_OPTIONS` | Preview up to three arrangements using current furniture. |
| `APPLY_LAYOUT_OPTION` | Apply a previously generated arrangement. |
| `CHANGE_WALL_COLOR` | Return structured wall color/finish instructions. |
| `CHANGE_FLOOR_COLOR` | Return structured flooring instructions. |
| `CHANGE_CURTAIN_COLOR` | Return structured curtain color, fabric, or style instructions. |
| `DESIGN_QA` | Answer questions about furniture, budget, spacing, and design choices. |
| `USER_FEEDBACK` | Correct layout, orientation, spacing, and circulation. |
| `OTHER` | General advice, clarification, and suggested next actions. |
| `NAVIGATE` | Recognize undo/redo; current chat execution is unsupported. |

Supporting capabilities:

- Conversation context and typed UI actions.
- Recommendations before add/replace unless an exact product is selected.
- Budget/fit warnings, user choices, and bounded layout repair.
- Progress streaming, response cards, previews, and revision-aware persistence.
- Room extraction/transfer and separate AI image polishing.

Limits: finish routes return UI instructions rather than saving scene changes. Recommendations do not guarantee placement fit. Selection has living-room assumptions and budget tolerance. Fit confirmations are held in memory.

## Implementation order

1. **Richer context and typed actions:** product IDs, prices, finishes, preferences, and exact card selections.
2. **Catalog search and recommendation cards:** browse real products without editing the room.
3. **Selected-product add/replace:** exact targets, quantity, fit warnings, and Studio saves.
4. **Surface edits:** wall, floor, and curtain finishes.
5. **Layout analysis:** collision/clearance checks and coordinated corrections.
6. **Layout options:** preview alternatives and apply a selected option after checking the room revision.
7. **New-design generation:** furniture selection, layout generation/repair, and variants.
8. **Later:** room import/transfer, image polishing, and broader undo/redo.

Start with **1–3**: ask for products, compare options, select one, and save the addition or replacement in Studio.

## References

- [Pipeline routes](/Users/anquach/Code/freelance/livinit/codebase/livinit_pipeline/src/nodes/orchestrator_routes.py:42)
- [Intent and recommendation policy](/Users/anquach/Code/freelance/livinit/codebase/livinit_pipeline/src/nodes/orchestrator_route_policy.py:414)
- [Chat execution, navigation, and finish handling](/Users/anquach/Code/freelance/livinit/codebase/livinit_pipeline/src/api/chat_workflow.py:824)
- [Fit checks](/Users/anquach/Code/freelance/livinit/codebase/livinit_pipeline/src/nodes/orchestrator_scenarios.py:305) and [confirmation storage](/Users/anquach/Code/freelance/livinit/codebase/livinit_pipeline/src/api/fit_confirmation.py:26)
- [Selection rules](/Users/anquach/Code/freelance/livinit/codebase/livinit_pipeline/src/nodes/asset_selection/validation.py:335) and [budget tolerance](/Users/anquach/Code/freelance/livinit/codebase/livinit_pipeline/src/nodes/asset_selection/constants.py:9)
- [Layout options](/Users/anquach/Code/freelance/livinit/codebase/livinit_pipeline/src/nodes/layout_options.py:994) and [response cards](/Users/anquach/Code/freelance/livinit/codebase/livinit_pipeline/src/nodes/architect_response/builder.py:844)
- [Decorator tools](../packages/decorator-agent/src/studio-tools.ts), [runtime](../packages/decorator-agent/src/decorator-session.ts), and [Studio contract](Studio-Contract.md)
