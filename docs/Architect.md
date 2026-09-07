# Livi Agent Architecture

Status: high-level proposal. Implementation details will be planned later using the PI project as a reference.

## Purpose

Build a room-decoration assistant for the existing 3D website. It understands the room, recommends catalog items, and helps users preview and apply decoration changes.

## Stack

| Layer | Component | Responsibility |
| --- | --- | --- |
| Website | Existing chat UI and 3D canvas | User interaction, previews, and rendering |
| Decorator application | Local Decorator Agent | Decoration prompts, tools, sessions, and website integration |
| Agent engine | Local Agent Core, adapted from PI | Model/tool loop, agent state, and execution events |
| Model integration | PI AI | Model providers and response streaming |
| Application services | Room, catalog, and storage services | Room state, products, layout checks, and saved designs |

First copy PI's Agent Core into a local `agent-core` package and simplify it to the execution features Livi needs. Then build `decorator-agent` on that local core, following PI Coding Agent's composition pattern: `DecoratorSession` wraps `Agent`.

Keep the core independent of room decoration. PI AI remains a dependency for model integration.

## Workspace structure

```text
livi-agent/
├── docs/
│   └── Architect.md
└── packages/
    ├── agent-core/           # Copied from PI, then simplified for Livi
    └── decorator-agent/      # DecoratorSession, prompts, tools, and integration
```

Start with these two packages only. Decorator Agent owns room-specific contracts and integration code. The existing website and backend connect to it; separate client, contracts, and server packages are deferred.

Dependency direction: `decorator-agent` → local `agent-core` → PI AI.

## Build order

1. Copy Agent Core from the PI project, retaining its license and attribution.
2. Simplify the local core around the model/tool loop, state, streaming events, and cancellation.
3. Build Decorator Agent on the local core and connect it to the existing room application.

Choose the exact features to retain during implementation planning against PI's source.

## Interaction flow

1. The user sends a decoration request from the website.
2. The chat server passes the request and room context to Decorator Agent.
3. The local Agent Core runs model turns and invokes the available decorator tools.
4. Application services retrieve products, validate changes, and create a preview.
5. The browser renders the preview for user approval.
6. The backend saves approved changes and synchronizes the canvas.

## Decorator capabilities

The initial tools cover reading room context, searching the catalog, proposing scene changes, validating layouts, undoing changes, and saving designs.

The agent is limited to these application capabilities. The backend enforces room permissions and owns committed state; the browser renders that state and temporary previews.

## PI references and later planning

Use the local PI checkout as the implementation reference:

| Reference | What to study |
| --- | --- |
| [PI Coding Agent](../../pi/packages/coding-agent/) | Application package organization and session composition |
| [SDK factory](../../pi/packages/coding-agent/src/core/sdk.ts) | Constructing an Agent and wrapping it in an application session |
| [AgentSession](../../pi/packages/coding-agent/src/core/agent-session.ts) | Conversation lifecycle, context management, and events |
| [PI Agent Core](../../pi/packages/agent/) | Source for the local core and its simplification |
| [PI AI](../../pi/packages/ai/) | Provider integration and streaming |

Detailed APIs, schemas, tool contracts, persistence, recovery, and deployment choices will be defined during implementation planning.
