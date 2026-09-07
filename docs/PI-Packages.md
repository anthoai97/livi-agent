# PI Package Relationships

Reference: the local [PI packages](../../pi/packages/) checkout inspected on September 6, 2026. Dependencies below describe that checkout, not a guarantee about future versions.

## Package overview

| Package | Purpose | Direct PI workspace dependencies |
| --- | --- | --- |
| `ai` | Model provider integration and response streaming | `telemetry` |
| `agent` | Agent Core: state, model/tool loop, execution events, and the durable harness | `ai`, `chord`, `telemetry` |
| `coding-agent` | Coding assistant: sessions, coding tools, prompts, extensions, and CLI | `agent`, `ai`, `tui`, `chord` |
| `tui` | Terminal rendering and interactive UI components | None |
| `chord` | Plugin composition, service interfaces, and synchronized state | None |
| `protocol` | Message envelopes, encoding, and framing for client/server communication | `chord` |
| `client` | Connects to PI servers and calls or subscribes to services | `protocol`, `chord` |
| `server` | Routes client requests to hosted sessions and services | `agent`, `protocol`, `chord` |
| `session-backends/sqlite-node` | SQLite persistence for the durable session system | `agent`, `ai` |
| `telemetry` | Shared tracing interfaces and utilities | None |
| `evals` | Evaluates coding-agent behavior using models | `coding-agent`, `ai` as development dependencies |

“None” means no dependencies on other PI workspace packages; external dependencies may still exist. The table lists runtime dependencies except for `evals`. `coding-agent` additionally declares `client`, `protocol`, and `server` as development dependencies.

## Main relationships

The central execution chain is **Coding Agent → Agent Core → PI AI → Model Provider**.

`coding-agent` builds its `AgentSession` around an `Agent` from `@earendil-works/pi-agent-core`, whose repository folder is `packages/agent`. The wrapper adds coding-specific tools and application behavior. `tui` provides the terminal interface.

The client/server stack supports running the agent separately from its interface. `client` and `server` communicate using `protocol`, while `chord` supplies service and state-sharing machinery. This stack is experimental. `client` is a communication library, not a ready-made chat UI.

`session-backends/sqlite-node` supplies persistence for durable sessions. `telemetry` supplies tracing abstractions, and `evals` measures application behavior.

## Mapping to Livi

| Livi package | PI reference |
| --- | --- |
| `agent-core` | Copy and simplify `packages/agent` |
| `decorator-agent` | Follow the application composition pattern of `packages/coding-agent` |

Livi's `DecoratorSession` will wrap its local `Agent`, adding decoration prompts, tools, and room integration.

PI's current `agent` package depends on `ai`, `chord`, and `telemetry`. Inspect which dependencies the retained features require before simplifying the copied core. The two-folder plan defines Livi's own packages; it does not mean the implementation has only two dependencies.

## Source references

- [Coding-agent dependencies](../../pi/packages/coding-agent/package.json)
- [SDK construction of Agent and AgentSession](../../pi/packages/coding-agent/src/core/sdk.ts)
- [Agent Core dependencies](../../pi/packages/agent/package.json)
- [Chord overview](../../pi/packages/chord/README.md)
- [Client overview](../../pi/packages/client/README.md)
- [Server overview](../../pi/packages/server/README.md)
- [Protocol overview](../../pi/packages/protocol/README.md)
