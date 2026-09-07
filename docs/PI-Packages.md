# PI Package Relationships

Livi copies PI revision `da840b6216578c2a571d0374ac6a2091a83f9d91`. See [provenance](PI-Provenance.md) for attribution and adaptations. See [reuse and local adaptations](PI-Reuse.md) for the copied-file inventory and local differences. The sibling `../pi` checkout was an implementation reference, not a runtime or build dependency.

| PI package | Livi location | Direct PI dependencies |
| --- | --- | --- |
| `agent` | `packages/agent` | AI, Chord, telemetry |
| `ai` | `packages/ai` | telemetry |
| `chord` | `packages/chord` | None |
| `telemetry` | `packages/telemetry` | None |
| `protocol` | `packages/protocol` | Chord |
| `client` | `packages/client` | protocol, Chord |
| `server` | `packages/server` | agent, protocol, Chord |
| `session-backends/sqlite-node` | `packages/session-backends/sqlite-node` | agent, AI |

“None” refers to PI dependencies; packages can have external dependencies. Livi’s applications live at the root in `livi-client/` and `livi-server/`, with shared libraries under `packages/`. Copied packages retain their upstream package names and use workspace links.

The execution chain is **DecoratorSession → AgentHarness/main lane → PI AI → Gemini**. The application registers only the Google provider and no tools. Core interfaces remain available for durable SQLite persistence and PI routing, while browser-facing contracts restrict application capabilities to chat.

The presentation chain is **React → PI client → framed protocol over WebSocket → PI server → Chord service endpoints**. Server-scoped endpoints expose conversation discovery and management. Session-scoped endpoints expose prompt/abort and replicated transcript/execution state. Every presentation gets its own attachment and subscriptions.

Livi adapts only the necessary service composition from PI's `coding-agent/src/experimental/services`. It does not copy the coding-agent application, tools, terminal UI, plugin loading, or coding execution environment.
