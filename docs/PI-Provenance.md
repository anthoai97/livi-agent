# PI source provenance

Source: https://github.com/earendil-works/pi
Revision: `da840b6216578c2a571d0374ac6a2091a83f9d91`
License: MIT (see the notice below).

`packages/{agent,ai,chord,telemetry,protocol,client,server}` and
`packages/session-backends/sqlite-node` contain the copied PI libraries.
Their npm package names remain the upstream names. The runnable Livi applications live at
`livi-client/` and `livi-server/` in the repository root. The upstream notice for these libraries is retained below.

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
notice is also covered by the notice below.

Detailed inventory and local adaptations: [PI reuse](PI-Reuse.md).

## Upstream copyright and permission notice

The following applies to the copied PI packages and adapted coding-agent services described above.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
