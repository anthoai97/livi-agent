# Livi chat prototype

A standalone React chat app backed by one Node server, Gemini, PI's durable AgentHarness, and SQLite. Supports streamed answers, saved conversations, Stop, and recovery. Attach a separately running Studio to move, rotate, or remove placed objects through the decorator agent. General chat works without a Studio.

The applications live in `livi-client/` and `livi-server/`; shared core packages live in `packages/`.

## Setup

Use Node 24 and pnpm 10.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Set GEMINI_API_KEY in .env
pnpm dev
```

Open http://127.0.0.1:5173. Vite proxies `/api/bootstrap`, `/health`, and `/ws` to the server on `127.0.0.1:3001`. Both services bind to loopback by default. The key stays on the server. `GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`; set it to a model present in the retained PI catalog when needed.

For a built app:

```sh
pnpm build
pnpm start
```

Open http://127.0.0.1:3001. Node serves the built frontend, API, and WebSocket endpoint. This prototype has no login system and is intended for local use.

## Checks

```sh
pnpm typecheck
pnpm build
pnpm test
```

For browser verification, install Playwright Chromium (`pnpm exec playwright install chromium`), then run `pnpm test:browser`. Alternatively, set `CHROME_PATH` to an installed Chrome executable. This creates temporary conversations with an injected provider and writes a screenshot to `artifacts/chat-browser.png`.

Tests inject a deterministic PI model provider and do not use Gemini credentials. The source includes copied model catalogs and SQLite migrations; normal installation and builds do not need `../pi` or catalog downloads. See [PI provenance](docs/PI-Provenance.md) for upstream attribution and local adaptations.

## Persistence and lifecycle

The server stores one database per conversation in `.data/sessions` and its stable identity in `.data/server-id`. Use `LIVI_DATA_DIR` to change the data directory. Run one server process per data directory.

Accepted prompts are persisted before their operation ID returns. Disconnecting or switching conversations releases the presentation subscriptions while generation continues. Reconnection attaches to the selected conversation and hydrates a new transcript snapshot; it never resubmits a prompt. Reopening an interrupted conversation drives its existing operation, so an incomplete model response can be regenerated without duplicating the user entry. Stop requests cancellation by operation ID.

The browser stores only the selected conversation ID locally. Conversation content comes from the server. Raw HTML in Markdown is disabled. See [architecture](docs/Architect.md) and [package mapping](docs/PI-Packages.md).

## Connect a Studio

Set `STUDIO_ALLOWED_ORIGINS` to the comma-separated exact origins of your Studio, for example `http://localhost:3000,http://127.0.0.1:3000`, and restart the server. The allowlist applies to `/api/bootstrap` and WebSocket connections. Same-origin chat remains available. Use the host and port your Studio actually serves; the example is not automatic discovery. Credentials stay on the agent server.

The companion Studio adapter imports the shared contract and connects to `/ws` using the bootstrap server ID. It registers its design/tab, subscribes to its private mailbox, then calls `ready`. It answers fresh-context requests, executes commands against live saved state, and reports durable command status. See [the contract and coordinate mapping](docs/Studio-Contract.md).

Build consumable packages for the separate Studio checkout with:

```sh
pnpm pack:studio --out /tmp/livi-studio-contracts
```

Install all tarballs listed by `/tmp/livi-studio-contracts/handoff.json` together in the Studio checkout, for example `npm install --ignore-scripts --omit=optional /tmp/livi-studio-contracts/*.tgz`. External consumers import `@livi/studio-contracts`; workspace consumers use `@livi/decorator-agent/contracts`. The handoff verifies an isolated consumer's types, browser bundle, and runtime imports. Do not copy contract definitions or depend on this repository's `workspace:*` links.

In chat, select a conversation, choose a connected Studio, and click **Attach design**. The panel shows the attached design, selected placed objects, and Offline, Reconciling, or Ready. Changing conversations and changing a design are separate controls. A design remains locked while an action's outcome is unresolved.

Ask directly, for example “move the sofa 0.5 metres right”. The agent resolves the object from the room inventory and asks which one when the target is ambiguous. Clicking an object in Studio is optional; selection is only a hint.

Only move, yaw rotation, and remove are supported. Moves use metres: +X right, +Y back, +Z up, from the floor's front-left. Rotation uses radians around +Z. “Move it back” and “undo that rotation” use saved before/after transforms, including after reopening a conversation. An intervening change to that object's transform prevents reversal. A rejected reversal blocks further room edits in that response; clarify with a new message. Removal cannot be reversed; adding, replacing, restoring, materials, and layout generation are outside this scope.

Reconnect hydrates attachment and action history without resending a prompt or command. Stop prevents unsent work and ends the model response. A command already sent may still save; the **Room actions** list shows its eventual saved, rejected, or uncertain outcome even after Stop. A timeout is not proof of rollback. Keep Studio connected to reconcile it.

## Headless room smoke

Run the synthetic deterministic suite after building:

```sh
pnpm build
pnpm smoke:studio --room scripts/studio-smoke/fixtures/synthetic-room.json --cases scripts/studio-smoke/fixtures/synthetic-cases.json --mode injected
```

The runner starts a temporary server with real SQLite and real WebSocket services, plus two headless Studios. It edits local JSON copies only. Room state and command deduplication evidence are written atomically to a temporary file; source fixtures and databases are never modified. The machine-readable report at `artifacts/studio-smoke.json` includes prompts, emitted commands, before/after JSON, revisions, terminal model status, tool results, saved outcomes, and independent assertions. Its summary identifies the temporary state directory for inspection. Run strict export-validation checks with `node --import tsx --test scripts/studio-smoke/fixture.test.ts`.

For natural-language verification, load server credentials into the process and use `--mode real`; for example, `node --env-file=.env --import tsx scripts/studio-json-smoke.ts --room <mapped-export.json> --cases <scenarios.json> --mode real`. `GEMINI_MODEL` optionally selects the server model. Injected mode uses scripted responses and proves deterministic integration, not natural-language understanding. Timing fault scenarios are skipped in real mode and covered by injected mode. Assertions check structured actions, numeric values, and preserved fields, not exact assistant wording. `--report <path>` chooses another report file.

The actual database export and its field mapping are still pending. The checked-in fixture is **synthetic**, not database-derived. To supply an export, create a JSON wrapper with `provenance: "database-export"`, `sourceDescription`, the explicit `coordinates` declaration shown in the synthetic fixture, and `snapshot` matching `StudioSnapshot`. Map these required fields from the supplied export:

| Field | Required source evidence |
| --- | --- |
| `designId`, `revision` | Stable design identity and canonical saved revision |
| `geometry.floor`, `geometry.height` | Floor polygon in manifest XY metres and room height |
| `openings` | Verified door/window IDs, positions, and dimensions; an empty array only for a room known to have none |
| `objects[].id`, `name`, `category` | Placed instance identity and identifying text; catalog IDs cannot substitute for instance IDs |
| `objects[].dimensions`, `position`, `rotation`, `scale` | Explicit finite transform/dimension triples in the documented coordinates; yaw only |
| `selectedObjectIds` | Initial selection, or `[]` when nothing is selected; each scenario supplies these optional hints |

Do not invent missing revisions, geometry, IDs, transforms, or coordinate conversions. Unknown extra snapshot/object fields are preserved and checked during mutations. Raw database shapes need a reviewed explicit mapping before this runner can consume them; the illustrative snapshot is not a database schema. Scenario expectations must name exported instances and expected coordinates independently of model output.

JSON saves simulate Studio persistence. The supplied database-export smoke and issue #7's joint real Studio move/rotate/reverse/remove/reload acceptance remain pending until their inputs and integration are available. Passing synthetic tests does not establish real editor validation, backend command deduplication, or production saves; those belong to the companion [web-pipeline issue #36](https://github.com/Livinit-ai/web-pipeline/issues/36).
