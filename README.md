# Livi chat prototype

A standalone React chat app backed by one Node server, Gemini, PI's durable AgentHarness, and SQLite. Supports streamed answers, follow-up context, saved conversations, Stop, and recovery when an interrupted conversation reopens. No tools, skills, extensions, MCP, room integration, or 3D features are exposed.

## Setup

Use Node 24 and pnpm 10.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Set GEMINI_API_KEY in .env
pnpm dev
```

Open http://127.0.0.1:5173. Vite proxies `/api/bootstrap`, `/health`, and `/ws` to the server on `127.0.0.1:3001`. Both services bind to loopback by default. The key stays on the server. `GEMINI_MODEL` defaults to `gemini-2.5-flash`; set it to a model present in the retained PI catalog when needed.

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

Tests inject a deterministic PI model provider and do not use Gemini credentials. The source includes copied model catalogs and SQLite migrations; normal installation and builds do not need `../pi` or catalog downloads. See [PI provenance](vendor/pi/PROVENANCE.md) for upstream attribution and local adaptations.

## Persistence and lifecycle

The server stores one database per conversation in `.data/sessions` and its stable identity in `.data/server-id`. Use `LIVI_DATA_DIR` to change the data directory. Run one server process per data directory.

Accepted prompts are persisted before their operation ID returns. Disconnecting or switching conversations releases the presentation subscriptions while generation continues. Reconnection attaches to the selected conversation and hydrates a new transcript snapshot; it never resubmits a prompt. Reopening an interrupted conversation drives its existing operation, so an incomplete model response can be regenerated without duplicating the user entry. Stop requests cancellation by operation ID.

The browser stores only the selected conversation ID locally. Conversation content comes from the server. Raw HTML in Markdown is disabled. See [architecture](docs/Architect.md) and [package mapping](docs/PI-Packages.md).
