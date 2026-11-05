# STATUS — Hepta Listen

Updated after every step of the build order. Newest step last.

## Step 1 — port packages ✅

Ported from `Djoek47/tacit@0294e8a` (`packages/`). `Djoek47/Heckit` has no refs on GitHub (empty
repository, no `v1` branch), so tacit is the source.

| Package | From | Changed in the port |
| --- | --- | --- |
| `packages/core` (`@intermenu/aiuic-core`) | tacit `packages/core` | nothing |
| `packages/resolve` (`@intermenu/aiuic-resolve`) | tacit `packages/resolve` | nothing — `JevResolver`, `JevTransport`, `httpTransport` as they were |
| `packages/hepta` (`@intermenu/hepta`) | tacit `packages/hepta` | nothing — `lines.ts` (threads, stances, floor, cut-in rules), `Speculator`, replay suites |
| `packages/memory` (`@intermenu/aiuic-memory`) | tacit `packages/memory` | nothing (the pyramid's congregator writes to it) |
| `packages/pyramid` (`@intermenu/aiuic-pyramid`) | tacit `packages/pyramid` | `App` was imported from `aiuic-kit`; it is now a 3-member structural type in the same file (`ui`, `reset`, `draw`). The kit pulls in menus, presenters and lints a listener has no use for. Tests use `test/app.ts`, the kit's final-sentence `hear()` path copied line for line. |

Decided rules carried over unchanged (and still tested):
concede below 0.4 confidence on a real reason · push once per disagreement (twice at bluntness ≥ 0.75) ·
cut in only at clause boundaries unless urgent (≥ 0.9) · nods are not turns · a contradiction never
overwrites the claim until `settle()` · a point queued on half a sentence is rechecked on the whole.

**Tests:** 205 passing (core 46, resolve 81, hepta 39, memory 22, pyramid 17). `npm run typecheck` clean.
**Replay (`npm run hepta`):** speech 16/16 on the act, 0 early commits, 0 wrong holds; cut-in suite 14/14, 0 wrong cuts.

**Next:** step 2 — the Jev `Detector` interface, heuristic + Haiku backends, bench harness.
