# PI source provenance

Source: https://github.com/earendil-works/pi
Revision: `da840b6216578c2a571d0374ac6a2091a83f9d91`
License: MIT (see [LICENSE](LICENSE)).

`packages/{ai,chord,telemetry,protocol,client,server}` retain their upstream names.
Upstream `packages/agent` lives at `../../packages/agent-core`; upstream
`packages/session-backends/sqlite-node` lives at `../../packages/session-backends/sqlite-node`.
Each extracted package also carries the upstream MIT license.

Local integration changes use workspace dependencies and adjust build/test paths.
The AI default build validates and copies checked-in provider data without network
access. Explicit catalog generation remains available through its upstream scripts.

Provider JSON data was hydrated using this revision's unchanged generator on
`2026-09-07T08:48:07.765Z` from models.dev, NVIDIA NIM, OpenRouter, and Vercel
AI Gateway. The generated manifest records file hashes; data-only hydration
retains the upstream TypeScript provider catalog structure.

The AI package declares its existing `@smithy/types` import explicitly for pnpm's
isolated dependency layout.

`packages/decorator-agent/src/services` adapts the same revision's
`packages/coding-agent/src/experimental/services` transcript and session service
composition. The wrapper exposes only prompt/abort and create/attach/detach;
plugin, model-management, and coding capabilities are not exposed. Its MIT
notice is retained in `packages/decorator-agent/LICENSE`.
