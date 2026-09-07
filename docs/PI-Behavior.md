# PI agent behavior and decoration guides

Reference for a later phase; not implemented yet.

| What we provide | PI mechanism | Example |
| --- | --- | --- |
| Always-follow behavior | `systemPrompt` | Clarify ambiguous objects; confirm completion only after saving. |
| Decoration procedures and guidebook | `resources.skills` plus explicit content loading | Furniture placement and circulation guidance. |
| Room and user context | `toolContext` with a `systemPrompt` callback or `transform_context` | Room JSON, selection, style, and furniture to keep. |
| Enforced rules | `before_tool` and tool/adapter validation | Reject protected-object changes or outdated revisions. |

## Behavior instructions

Keep one short Markdown document. The server reads it and supplies its text through `systemPrompt`:

```text
Respond in the user's language.
Ask when multiple objects match the request.
Change only what the user requested.
Explain conflicts with the user's constraints.
Report completion only after a successful saved result.
```

Adding `AGENTS.md` or another document to the repository does not automatically load it into the running agent.

## Decoration guidebook

Use a focused skill such as `furniture-placement`. In our PI implementation:

- `resources.skills` registers skills but does not automatically inject their content.
- `formatSkillsForSystemPrompt()` lists only names, descriptions, and paths.
- `lane.accept({ kind: "skill", name, additionalInstructions })` admits the full skill content; the operation must then be driven.
- Referenced documents are not loaded automatically.

Initially, load the relevant guide text on the server and explicitly include it in model context. No filesystem tool is needed. Split a larger guide into relevant sections later.

Likewise, `toolContext` is application data: use the prompt callback or context hook to make the needed room facts visible to the model.

## Action control

Instructions guide the model; code enforces conditions before mutation. For example, “keep doorways clear” needs a geometry check if we want to prevent a blocking move. PI's `before_tool` hook can block a call with a reason; the adapter also validates against current room state.

Flow: **behavior + guide + room JSON + request → tool call → validation → Studio save → explanation.**

Start with **one behavior document, one placement guide, and validation in the three tools**, composed in `DecoratorSession`.

References: [PI harness interfaces](../packages/agent/src/harness/agent-harness.ts), [skill loading](../packages/agent/src/harness/skills.ts), [current DecoratorSession](../packages/decorator-agent/src/decorator-session.ts).
