---
name: orchestrate-implementation
description: Delegate implementation through Herdr. Use when the user explicitly requests implementation through Herdr or invokes this skill.
---

# Orchestrate implementation

Use a root orchestrator and one implementation agent in Herdr. Invoking this skill selects Herdr; honor an explicit user override. Use the configured model with medium effort unless the user requests otherwise.

## Set up and assign

- Read applicable repository instructions and inspect the working tree, branch, HEAD, and relevant PR/stack state. Preserve unrelated changes and capture the requested behavior and constraints.
- Load the Herdr skill, verify `HERDR_ENV=1`, and discover the CLI and actual root pane. Create a sibling pane in the same directory by default, without changing focus. Follow Herdr's readiness and prompt-delivery guidance; track every pane created for cleanup.
- If Herdr is unavailable, stop Herdr operations, report the limitation, and continue other authorized work. Ask before substituting another implementation backend when the user required Herdr.
- Give the implementation agent ownership of implementation and relevant tests, docs, and builds. The root independently inspects companion code or integration points and resolves boundary questions. Add agents only for concrete independent work; avoid overlapping edits.
- Assign one owner for Git mutations in a shared checkout. Use separate worktrees when writers need independent branches.

Send a self-contained brief with `herdr agent prompt`, omitting irrelevant fields:

```text
Task: <requested behavior, scope, acceptance scenario>
Repository/state: <absolute path, branch, HEAD, relevant base/PR, existing changes>
Ownership: <agent's files and checks; root's independent investigation>
Constraints: <architecture, exclusions, allowed builds and external actions>
Handoff: <local diff, commit, or authorized draft PR and base>
Report to: <actual root target via herdr agent prompt>
Flag scope changes early. Return changed behavior/files, check results, limitations,
and commit/PR details when applicable.
```

## Coordinate and verify

Use Herdr for assignments, follow-ups, and handoffs. Reuse existing agents. Share discoveries and user steering promptly; report meaningful progress without fixed milestone ceremonies. Inspect agent state/output when needed—silence or a pane title is not completion.

Companion-code findings do not authorize edits to that repository. Keep external actions within the current task's authorization; unrelated historical permission does not carry over.

The root verifies the final diff and acceptance scenario, including relevant failure cases. Ensure tests exercise the requested behavior rather than passing through unrelated automatic behavior. Run targeted checks and required builds; repeat only after changes, failures, or unresolved concerns. Distinguish synthetic checks from live-system evidence. Use independent review when it adds confidence, without fixed review loops unless required.

## Finish

For authorized draft PRs, inspect `gh stack` help and use the intended base; split large changes into small dependent PRs. Verify the PR URL, draft status, base, commit, and working-tree state. PR preparation alone does not authorize merging, deployment, or other external actions.

Resolve remaining work before handoff. Include a concise **Change | Related code** Markdown table linking meaningful behavior to verified file lines, followed by validation and material limitations or commit/PR status. Use absolute clickable file targets with repository-relative labels.

Close and verify closure of panes created for this task before the final response, unless the user asks to keep them. Preserve the root and all pre-existing panes.
