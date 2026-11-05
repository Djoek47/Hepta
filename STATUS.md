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

## Step 2 — Jev interface, two backends, bench harness ✅

**The seam.** `packages/listen` defines one `Detector` interface (`detect(heard, state) → Judgment`). Every chunk
becomes one `JevDecision`: `{speaker, topic, shiftType, diversion?, claim?, addressedToHepta, respondState,
confidence, latencyMs}` plus the readings still alive, whether it was made on a partial, and the clause boundary.

| Backend | What it is |
| --- | --- |
| `heuristic` (local, tier 0) | Topic lexicon + content words, surface cues for each diversion type, the ported number grammar for claims, question shape and addressee by name, ad / crowd / nod gates. Weighs every cue against what memory holds (open questions, standing claims, evidence pack). |
| `jev-haiku` (tier 1) | `JevDetector` asks typed questions (Choice / Noul with probabilities and a runner-up) through the **ported `JevTransport`**; `haikuTransport` answers them with Claude Haiku 5.5: cached system prompt (~1.4k tokens, above the 512 minimum), thinking off, effort low, one fixed JSON schema (structured outputs), streamed with time-to-first-token recorded. 4 questions on a partial, up to 7 on a final. Numbers stay local. A late or failed answer falls back to the local judgment. The hosted Jev (`httpTransport` from aiuic-resolve) plugs into the same place. |

**Bench.** `npm run bench` plays the 10 scripted clips through a simulated streaming recognizer (partials every
2 words, a final per sentence, word timings, diarization labels; seeded onset-lag, flicker and misheard-word
revisions) and scores every decision against the labels. Report: console, `bench/out/report.md`, `report.json`.
The bench names speakers when they first speak, as an operator would (`--no-names` turns that off).

**Baseline (heuristic, before steps 3–6):**

| | heuristic | jev-haiku |
| --- | --- | --- |
| diarization (words) | 99.6% (recognizer 96.3%) | not run — no `ANTHROPIC_API_KEY` |
| topic shift P / R | 0.37 / 0.70 | |
| diversion P / R | 0.63 / 1.00 | |
| dodged questions | 0 / 3 found (nothing counts turns yet) | |
| contradictions P / R | 1.00 / 0.88 | |
| ads & crowd / nods / addressed P | 0.89 / 0.89 / 0.86 | |
| wrong interruptions | 0 | |
| decision latency median / p95 | 0.15 ms / 0.59 ms | |

Known from the misses list (`npm run bench -- --misses`): open questions never close on a change of subject,
so later turns read as deflections; "Hepta speaks for the motion" counts as addressing Hepta; an ad's label
carried over onto the moderator's "Welcome back."; "Yes, absolutely." to a question put to the whole panel is
taken for a nod. Steps 4–6 own these.

**Tests:** 244 passing (39 new: text, heuristic, Jev mapping and fallback, Haiku transport against a fake
client, listener ordering and boundaries, simulator, scoring). `npm run typecheck` clean.

**Keys:** `.env.example` lists `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`. None is needed for
the heuristic backend or the bench.

**Next:** step 3 — streaming STT with diarization (Deepgram / AssemblyAI behind one interface), mic and file input.
