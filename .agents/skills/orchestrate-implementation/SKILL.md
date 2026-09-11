---
name: orchestrate-implementation
description: Coordinate multi-agent implementation through Herdr panes with a root orchestrator, a clearly owned implementation task, independent companion-code inspection, targeted validation, and an optional draft stacked PR handoff. Use when the user asks to spin up implementation agents or repeat this delegated development workflow.
---

# Orchestrate implementation

Run the requested change to completion with a root orchestrator and an implementation agent in Herdr. The user has chosen Herdr as this skill’s default coordination mechanism; invoking this skill requests Herdr without needing to repeat it in the prompt. Do not ask which coordination surface to use. Keep ownership explicit, give agents concrete work, and preserve the user's architecture and execution constraints.

## Establish the work

Read applicable AGENTS.md instructions and inspect the working tree, branch, HEAD, and relevant existing PR/stack state. Preserve unrelated existing changes; do not discard them or include them in the task’s commits. Capture the intended behavior, regression scenario, repository paths, and explicit restrictions. Distinguish new authorization from historical instructions: a previous permission to publish a PR, restart a server, or mutate a room does not authorize that action for every future task.

Use the user's configured model and "MEDIUM" effort unless they request another. Do not bake project names, pane IDs, commits, PR numbers, or model versions from an example into a new assignment.

## Start agents and divide ownership

Load the available Herdr skill, verify `HERDR_ENV=1`, and discover the installed CLI. Identify the actual root pane. Create a sibling pane in the same working directory with focus preserved, start the requested agent, and send the assignment with `herdr agent prompt`. Follow the Herdr skill for readiness and message delivery. Never assume the root is `wS:p1`.

Use Herdr for implementation agents, additional reviewers, milestone messages, and final handoffs. Send follow-ups to the existing agent instead of spawning replacements for the same work. Do not silently substitute collaboration tools or invisible subagents. If Herdr is unavailable or this session is outside Herdr, report the concrete limitation and continue useful local inspection; ask about an alternative only when the requested delegation cannot proceed. Honor an explicit user override of the coordination mechanism.

Give the implementation agent one coherent scope: implementation, relevant tests, concise docs, and builds for the code it owns. Include Git/PR work only when authorized. The root independently reads companion code, verifies external assumptions, and resolves boundary questions while implementation proceeds. For a single-repository task, the root can inspect integration points or review regression coverage instead.

Allow additional agents only for concrete independent tasks that improve speed or quality, such as inspecting installed API types or reviewing safety invariants. Do not assign overlapping file edits. One agent owns Git mutations in a shared checkout; other agents must not switch its branch, stage its changes, or commit concurrently. Use isolated worktrees if separate writers need independent branches.

## Send a self-contained implementation brief

Adapt this template to the actual request; omit inapplicable fields:

```text
Implement: <user-visible behavior and scope>.
Root Herdr pane/agent: <actual coordination target>. Repository: <absolute path>.
Starting state: <branch, HEAD, relevant PR/base, working-tree state>.
You own: <files/components, implementation, tests, docs, specific builds>.
Root owns: <independent read-only investigation or integration work>.
Preserve: <architecture and important invariants>.
Authorized change: <behavior the user explicitly wants changed>.
Acceptance: <concrete before/event/after scenario and meaningful regression>.
Constraints: <excluded builds, live systems, DB writes, dependencies, protocol changes>.
Git handoff: <local diff/commit or authorized draft stacked PR and intended base>.
Report early: <findings that would require companion changes or alter scope>.
Use herdr agent prompt <root target> for milestones and final handoff with changed files,
checks/results, commit and PR URL if applicable, and remaining limitations.
```

Require full inspection of relevant files before editing and actual installed dependency types for uncertain APIs. Prefer changes to existing functions and the current architecture over adding parallel implementations or unnecessary compatibility paths.

## Coordinate during execution

The root sends useful discoveries promptly, especially interface behavior, existing infrastructure that avoids extra work, and constraints that invalidate an approach. Findings from companion source are evidence, not permission to modify that repository.

Relay user steering while preserving the original task. State whether you agree with feedback before describing the adjustment. Distinguish questions that need the user's decision from implementation choices the agents can resolve themselves.

The implementation agent reports milestones at meaningful boundaries: mechanism understood, approach chosen, regression established, checks complete, and handoff published. Keep the user informed without dumping terminal output. Use `herdr agent prompt` for assignments, follow-ups, and reports to the actual root target; use Herdr agent read/get/wait to inspect progress as needed. Do not interpret silence, a terminal title, or an unknown lifecycle state as success.

## Validate and hand off

Prove the requested behavior through observable state or effects, including failure cases that could undermine the change. Check that tests cannot pass because unrelated automatic behavior masks a missing implementation. Update tool registration, provider schemas, or integration assertions when interfaces change.

Run targeted tests, required lint/type checks, and only the authorized builds. Use synthetic/injected smoke checks when useful; clearly separate them from real-model, real-editor, or production evidence. Once checks pass, repeat only for a new change or unresolved concern.

Have an independent agent inspect a bounded risk or final diff when that adds meaningful confidence. Do not impose a fixed number of review loops or run a special review-only workflow unless requested or required by applicable instructions.

If the user authorized draft PR publication, use `gh stack` to create a small follow-up atop the intended base, or split a large change into reviewable dependent PRs. Inspect installed command help before use. Give the PR a concrete problem/behavior description and validation evidence. Verify its URL, draft status, base, commit, and local working-tree state. Do not merge, comment, deploy, restart live services, or perform other external actions merely because this workflow includes PR preparation.

The implementation agent returns changed files, behavior, tests/builds, commit/PR information, and limitations. The root verifies that handoff against the agreed acceptance criteria, resolves remaining work, and gives the user a concise final result. Do not stop at a plan or an agent's unsupported claim of completion.

Every final development handoff includes a concise Markdown table with columns **Change** and **Related code**. Describe each meaningful behavior in plain language and link it to the relevant implementation file and verified line number. Use clickable absolute file targets, with readable repository-relative paths as labels; distinguish companion repositories when needed. Map behavior to code rather than listing every modified file. Follow the table with brief validation results and any material limitations or commit/PR status. Do not wait for the user to ask for the code mapping.

After verifying the final handoffs, close the implementation and review panes created for this task with `herdr pane close <pane-id>` before the root's final response, unless the user asks to keep them open. Track returned pane IDs and verify closure. Keep the root pane and all pre-existing panes open.
