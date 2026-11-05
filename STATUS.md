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
| `jev-haiku` (tier 1) | `JevDetector` asks typed questions (Choice / Noul with probabilities and a runner-up) through the **ported `JevTransport`**; `haikuTransport` answers them with Claude Haiku 5.5: cached system prompt (~1.0k tokens, above Haiku 5.5's 512-token minimum), thinking off, effort low, one fixed JSON schema (structured outputs), streamed with time-to-first-token recorded. 4 questions on a partial, up to 7 on a final. Numbers stay local. A late or failed answer falls back to the local judgment. The hosted Jev (`httpTransport` from aiuic-resolve) plugs into the same place. |

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

## Step 3 — streaming STT with diarization, mic and file input ✅

**One recognizer interface** (`SttProvider` → `SttSession`: send 16 kHz PCM, receive utterance chunks with
per-word speaker labels). Three behind it:

| Provider | Diarization | Notes |
| --- | --- | --- |
| `deepgram` (live) | per word | `wss://api.deepgram.com/v1/listen`, nova-3, `diarize=true`, interim results, punctuation, 300 ms endpointing, `UtteranceEnd` backstop, KeepAlive while idle, CloseStream to flush. Key in the `Authorization: Token` header. |
| `assemblyai` (live) | per turn | Universal-Streaming v3, `speaker_labels=true`, formatted turns; the turn's label goes to each word, `UNKNOWN` stays unlabelled; reads `speaker_label` or `speaker`. |
| `scripted` | per word | A bench clip through the simulated recognizer, at broadcast speed (or `--speed`). No keys. |

`UtteranceAssembler` turns segments into utterances (finalized words + interim on top, final at the endpoint)
and **splits an utterance where a new speaker holds three finalized words** — crosstalk with no pause otherwise
puts two people in one sentence.

**Not tested against the live services in this session:** no keys here, and the network policy blocks both
providers' hosts (`developers.deepgram.com`, `www.assemblyai.com` did not resolve). Both adapters are written to
the documented wire formats and tested against recorded-message fixtures (URL and auth header, interim/final/
endpoint handling, close/terminate). First live run is the open item.

**Inputs.**
- **Mic** and **file / URL** in the page: `apps/studio/web/capture.ts` taps the microphone, or the `<audio>`/`<video>`
  element playing the file (so the operator hears it at broadcast speed and the recognizer hears the same thing),
  through an AudioWorklet, downsampled to 16 kHz PCM (`Downsampler`, tested) and sent as binary WebSocket frames.
  URLs are fetched through the studio (`/media?url=`, public http(s) only) so the page may capture them.
- **File from the terminal:** `npm run listen -- --file debate.mp4` decodes (WAV natively; mp3/mp4/anything via
  ffmpeg), paces it in real time (`pace`, `--speed` to go faster) into Deepgram or AssemblyAI, prints every
  utterance with what Hepta made of it, and saves the session to `exports/`. `--clip 01` plays a scripted clip.
- **Studio server** (`apps/studio`, `npm start` → http://127.0.0.1:7474): one WebSocket session per operator;
  keys stay on the server and the page is told only which exist. The UI itself is step 7.

**Who is speaking.** S1, S2… in order of first speech; the operator can name them and give roles. An
utterance's speaker is the majority of its words weighted by duration, so a diarizer's onset lag and flicker are
absorbed instead of splitting sentences. Voices heard only in ads or crowd noise are marked `outside`.
Under harsher simulated diarization (`npm run bench -- --onset-lag 0.5 --flicker 0.08`):

| recognizer noise | recognizer words right | listener words right |
| --- | --- | --- |
| default (onset lag 0.15, flicker 0.02) | 96.3% | **99.6%** |
| onset lag 0.5, flicker 0.08 | 88.8% | **98.5%** |
| onset lag 0.8, flicker 0.15 | 79.2% | **93.3%** |

**Not the conversation.** Fixed from the step-2 misses: an ad voice no longer carries over onto a short line
like "Welcome back." (diarizers hand the first words after a break to the last voice); "Yes, absolutely." to a
question put to the whole panel is an answer, not a nod. Ads & crowd ignored P/R **1.00 / 1.00** (was 0.89 / 1.00);
nods are not turns **1.00 / 1.00** (was 0.89 / 1.00).

**Tests:** 261 passing (17 new: assembler, Deepgram and AssemblyAI against fixtures, scripted provider, WAV/
resample/ffmpeg/pace, downsampler, the studio over a real WebSocket — scripted clip end to end, audio frames
reaching the recognizer, a plain error when no recognizer key exists). `npm run typecheck` clean.

**Next:** step 4 — threads, topics and shift detection.

## Step 4 — threads, topics, shift detection ✅

**Lines of thought** (`packages/listen/src/threads.ts`). Each subject is a thread with a bag of the words it
has been discussed in, an owner (who opened it), and a weight: **+1 while on air, +0.5 each time its words come
up elsewhere, halved every 5 minutes** (`HALF_LIFE_MS`). One thread is on air at a time. Weights fade unless the
subject comes back.

**Subject per utterance, with continuity.** Most sentences carry on the subject on air; a sentence moves it
only with weight:
- lexicon words are strong or weak (`~jobs`, `~rent`, `~build`): one weak word never moves the subject
  ("getting on with the job", "rent is 1,450" in a budget);
- one strong word moves it in a statement that is off the subject, not in a question asked within it
  ("…lose their homes?" stays on the rail line) — unless it names a line already open ("What about the trip?");
- a cue moves it: "let's turn to…", "next,", "on council tax,", "still on…", "stay with…";
- an answer stays with its question's subject; "that's not what I asked" goes back to the question's;
- tonight's subject (debater stance, evidence pack) joins the lexicon and wins ties;
- a cue to Hepta in a panel has no subject (it is about the programme).

**Turning on a person or a record.** An ad hominem puts "about the doctor" on air, a whataboutism "the
shadow minister's record" — for a moment, without opening a line of thought. The person it turned on answering
back stays there; anyone else returns to the subject it left (a follow-up).

**Shift classification.** none · natural (a cue, or the moderator moving on) · follow_up (a link, a return
to an open line, back from a diversion, a subject raised in the last two turns) · diversion (an ad hominem or
whataboutism; a deflection only when it changes the subject — evading without changing it is a diversion with
shift none).

Also fixed while here: a question in the second sentence of a turn is put to the person named in the first
("Minister, the question was about funding. Where does the money come from?" was going to the last speaker);
asking the chair for the floor ("Can I come back on growth?") is not a question anyone must answer; between
equally good answers, the latest question wins; "Hepta speaks for the motion" is about Hepta, not to it.

| scripted set (dev) | step 2 | step 4 |
| --- | --- | --- |
| topic shift P / R | 0.37 / 0.70 | **1.00 / 0.95** |
| shift type right | 14/14 | 19/19 |
| diversion P / R | 0.63 / 1.00 | **1.00 / 1.00** |
| addressed to Hepta P / R | 0.86 / 1.00 | **1.00 / 1.00** |
| decision latency median / p95 | 0.15 / 0.59 ms | 0.17 / 0.51 ms |

**Read these numbers with care.** The 10 clips were labelled before any detector existed, but steps 2–4
tuned rules against their misses: they are a development set now. So this step also adds a **held-out set**
(`bench/holdout`, 4 clips, 40 turns: defence/pensions, a marathon plan, social media, farming) written before
any further tuning, with phrasings no cue lists. It is not run until the final report
(`npm run bench -- --set holdout`). Real TV clips are the real test.

The one shift still missed is semantic ("the committee's figures leave out the grid upgrades" returns to the
cost argument without a cost word) — the kind of call the Haiku backend is there for.

**Tests:** 270 passing (9 new: half-life, mention lift, on-air light, owner; continuity, weak words, cues,
questions within a subject, returns, ad hominem on air and back, answers keep their subject).

**Next:** step 5 — diversions, dodged questions (N turns), contradictions with quotes.

## Step 5 — diversions, dodged questions, contradictions ✅

**Questions.** A ledger of every question: who asked, who it was put to (by name — in the sentence, or in the
sentence before it in the same turn; held by name until that person first speaks), how often it has been asked,
and how many of the addressee's turns have passed without an answer. **A question is dodged when the person it
was put to takes N turns (default 2, `dodgeTurns`) without answering it.** A turn ends when someone else speaks;
nods and ads are not turns; asking again keeps the count; an answer after the dodge still closes it. What counts
as an answer is checkable where the question is: yes/no wants yes, no, or its own verb back ("are you on track?"
is not answered by "we will halve waiting lists"); "how will you pay" wants a source; "which is it, three or
five" wants one of them; "how much" wants a number; an open question is answered by the addressee's next turn if
it stays on the subject and neither deflects nor attacks. Asking the chair for the floor is not a question.

**Diversions** (each with the quotes it rests on — who said what, when, in their words):
deflection (an open question, a different answer) · whataboutism · ad hominem · question dodged (the count above)
· moving the goalposts (a commitment restated against a weaker test, or with a different target or deadline) ·
changed claim (same speaker, same subject, a different figure, ≥25% apart — quote both). An attack made while a
question is open says the question is still open.

**Claims.** Extracted with speaker, time, subject, value and unit, one per clause; the last word on a subject in
one breath stands ("650, no sorry, 400 like we said" contradicts nothing). **A contradiction is recorded beside
the claim it contradicts, never over it**; it is settled only by the speaker's own correction out loud ("sorry, I
meant…") or by the operator (`Memory.settle`). A revision under 25% updates the claim. Claims are checked against
the evidence pack (tolerance per item, default 15%).

**Insight cards** (`insights.ts`), in the brand's voice — they report, they do not accuse:
"S2 answered with the shadow minister’s record. S3’s question is still open." ·
"“How is it funded?” asked by S3 at 00:13, not answered." · "S2 said 3% at 00:06, now says 5%." ·
"S2 said 3% on unemployment; the evidence pack says Unemployment rate 4.1%." · "S1 asked again: …".
The same diversion carried into the next sentence of one turn updates its card instead of adding one.

Fixed on the way: sentences were split inside decimals ("4.1" → "4." + "1 percent") in the detector and in the
simulator; a claim's subject now carries to the next clause; every clause's claim is extracted (a `break` cut
sentences off after their first figure); "…yes or no?" is a yes/no question, not a choice between "yes" and "no".

| scripted set (dev) | step 4 | step 5 |
| --- | --- | --- |
| dodged questions P / R | — / 0.00 (no counting) | **1.00 / 1.00** (3 of 3, 0 false) |
| contradictions P / R | 1.00 / 0.88 | 1.00 / 0.88 |
| diversion P / R | 1.00 / 1.00 | 1.00 / 1.00 |
| topic shift P / R | 1.00 / 0.95 | 1.00 / 0.95 |

The contradiction still missed is semantic ("most companies quietly dropped it" against "92% kept it": no figure
to compare) — the Haiku backend's `contradicts` question is there for that. Same caution as step 4: these
clips are a development set; the held-out set and real clips decide.

**Tests:** 281 passing (11 new: dodge counting, nods not counted, re-asks, names bound late, what counts as an
answer, contradictions kept beside, self-correction settles, revisions, one breath, evidence cards).

**Next:** step 6 — the timing state machine (listen / note / ready / respond) on the ported Lines rules, readings
on fragments with provisional cards, and response cards written by Claude Sonnet.

## Step 6 — timing state machine, fragments, response cards ✅

**The four states** (`timing.ts`), decided on every chunk: **listen** · **note** (it is on a card; nothing to say)
· **ready** (a point is waiting — for a clause boundary, the end of the turn, or a cue) · **respond**.

- **Conversation and debater run on the ported Lines rules, unchanged.** Hepta's points become Lines threads
  (a changed figure, evidence against its stance, a question put to it) and Lines decides: cut in only at a clause
  boundary unless urgent; push once per disagreement; concede below 0.4 on a real reason; a point queued on half
  a sentence is rechecked on the whole. No listener urge reaches Lines' urgent level (capped at 0.89): **Hepta
  never takes the floor mid-clause.** A clause boundary comes from the recognizer: punctuation, a joint word, a
  pause in the word timings (the `Heard.boundary` seam added in step 2).
- **Panel:** Hepta never cuts in. Points wait (READY) until the moderator cues it or someone puts a question to
  it, or challenges it by name; the cue gets all waiting points at once, and they are cleared.
- **Debater:** evidence against the stance cuts in at the next boundary, once per disagreement (one Lines stance
  thread per evidence item). What the other side says next is a reply: a reason lowers confidence by 0.35;
  below 0.4 it concedes, and the next card says so. The sentence that earned the push is not a reply to it.
- **The end of a turn, not of a sentence.** A recognizer's final marks a pause; people go on after pauses. An
  answer held for the end of the turn waits until the speaker has been quiet `turnEndMs` (700 ms), moves with
  each further sentence, and waits while voice activity says someone is speaking whose words have not arrived
  (Deepgram `SpeechStarted`; the scripted recognizer emits the same). Someone else speaking ends the turn.
- **The floor while Hepta speaks** (TTS on): a nod keeps it going, "wait"/"no"/a sentence makes it stop (Lines).

**Fragments.** Each partial carries up to three readings. When one clearly leads (p ≥ 0.55, 0.15 ahead) a
**provisional** card is shown at once; on the whole sentence it is **confirmed** if it still holds, or
**retracted** — "What I can tell you is that it will be paid for by…" opens like a deflection and is an answer.

**Response cards** (`respond.ts`), written round the **ported pyramid**: the aggregator reads (the record's
points and open questions, the evidence pack), the orchestrator is the writer and gets copies only, the
congregator records goal → findings → plan → answer, and that ledger goes into the export. Writers:
- **Claude Sonnet 5.5** (`claude-sonnet-5-5`): streamed, thinking off (`between_tools`), low effort, cached
  system prompt (~700 tokens, above the 512 minimum), server-side refusal fallback (`fallbacks: "default"`).
  Short, on-screen, citing who said what and when. Used when `ANTHROPIC_API_KEY` is set.
- **Template** (no key, or when Sonnet fails — the ledger says so): reads the cards plainly; to a question in
  conversation it reads back the person's own figures with times and asks which changed figure stands.

| scripted set (dev) | step 5 | step 6 |
| --- | --- | --- |
| responses on time | 12/16 (baseline: answer on the sentence's final) | **15/16** |
| spoke out of turn / too early | 0 / 1 | **0 / 0** |
| **wrong interruptions** | 0 | **0** |
| early insights right | — | **8/8**, all confirmed, shown 2.7 s before the sentence ended (median) |
| response card (template) median / p95 | — | 0.11 ms / 0.88 ms |

The one response missed is the semantic contradiction from step 5 (no figure to compare): no point, no cut-in.
**Sonnet's time to card is not measured here** — no key in this session. `npm run bench` uses Sonnet
automatically when the key is in `.env` and reports first-text and full-card latency against the 1.5 s target.

**Tests:** 292 passing (11 new: cut-in at a boundary only, the end-of-turn wait, voice activity, panel cue with
waiting points, debater push-once and concession, the floor while speaking, provisional confirmed and
retracted, the pyramid ledger, writer fallback, the Sonnet request).

**Next:** step 7 — the operator UI: modes, inputs, live transcript with Jev tags, threads, cards, the response
card with READY/RESPOND, TTS, tuning marks and export.

## Step 7 — the operator UI, modes, tuning and export ✅

`npm start` → http://127.0.0.1:7474 (`apps/studio`). One screen, built for a broadcast operator:

- **Response card** at the top: what Hepta would say now, streamed as it is written, with the exact quotes it
  cites, why the timing chose this moment, and how long it took (first words, whole card). The **state light**:
  LISTEN (grey) · NOTE · READY (red ring, pulsing) · RESPOND (solid On-Air red). **Speak** reads it aloud;
  "speak responses aloud" is off by default. While it speaks, a nod keeps it going and "wait" stops it.
- **Live transcript**, coloured by speaker (muted hues — red is reserved for what is live), names and roles,
  partial lines in grey until final, nods and ads/crowd dimmed, and the Jev tags inline: subject, shift
  ("follow-up · from travel"), diversion, claims (≠ for a contradiction), "to Hepta", who did not answer what,
  the 2–3 readings still alive on a partial, and the backend's latency.
- **Lines of thought**: each thread's weight (5-minute half-life), who opened it, the one on air lit red; faded
  ones grey out. **Questions** not yet answered, with live timers — "asked 1:09 ago by S3 to S2 — not answered ·
  asked 3× · 2 turns since".
- **Insight cards**: provisional (dashed) → confirmed or retracted (struck through); a red edge while fresh
  (20 s), then history.
- **Modes**: Conversation / Debater / Panel. **Inputs**: scripted clip (1–8×, no keys), microphone, a file or a
  URL played in the page (a TV clip plays in the page while it is heard). Live inputs are disabled, with the
  reason shown, until a speech key exists. **Backends**: heuristic or Claude Haiku; **writer**: Sonnet or
  template. **Setup**: speaker names and roles (the moderator role matters in a panel), debater seed topic,
  stance and confidence, an evidence pack (one item per line). **Cue Hepta** cues it by hand.
- **Tuning marks** on every final decision, card and response: good · should have flagged · false flag ·
  too early · too late. **Export JSON** (`hepta-listen-session/1`): transcript, every decision, cards, responses
  with their pyramid ledgers, threads, questions, claims, stance replies, marks, and latency stats. The terminal
  runner (`npm run listen`) writes the same format.
- Light and dark themes (system, or the ◐ toggle); the spinning mark turns its seven threads while listening and
  pulses its waves on RESPOND; the centre dot — the listener — never moves (brand rule); reduced motion respected.
  At phone width the controls stack and the bar scrolls away; no horizontal scroll.

**Checked in a real browser** (Playwright, Chromium): clip 01 at 8× end to end — transcript, 5 cards, the
response, threads, questions, a mark, and an export whose response carries its ledger (goal → findings → plan
→ answer); no page errors; light, dark and phone width. **`npm run e2e:capture`**: a WAV chosen in the File input
plays in the page and reaches the studio as 3.02 s of 16 kHz PCM over 2.96 s of wall time — real speed, end to
end. Screens: `docs/screens/`.

Fixed while here: a question rephrased in the turn that just re-asked one is that question again (one card,
counted once per turn); shifts after an attack are named from the subject it left; "the real cost is 5 percent"
has the subject "real cost" (a verb after a determiner is a noun); naming a speaker before they speak sticks.

**Tests:** 293 passing (marks, operator cue and export over the WebSocket added). `npm run typecheck` clean.

**Next:** step 8 — the bench report (including the held-out set) and the README.

## Step 8 — bench report and README ✅

- **`npm run bench:report`** runs the scripted set and the held-out set (and any recorded clips) and writes
  [`bench/REPORT.md`](bench/REPORT.md): the numbers per backend, per clip, what the held-out set got wrong, and what
  every metric counts. A backend that did not run says "not run" in every cell.
- **Recorded clips** (your TV material): `npm run bench:draft -- --audio clip.mp4 --id my-clip` transcribes once at
  broadcast speed through Deepgram or AssemblyAI (cached), and drafts `clip.json` — turns with times and words —
  for labelling ([`bench/clips/README.md`](bench/clips/README.md)). The bench aligns what the recognizer heard with
  the labelled turns by time and scores them like scripted clips (tested: a scripted clip dressed as a recording
  scores identically).
- **Keeping up with a slow detector**: a partial already overtaken by a newer one is decided locally; the latest
  partial and every final go to the model (`Listener.skipped` counts them).
- **README** rewritten for the whole system: quick start without keys, what each key switches on, what it hears,
  the Jev seam, the timing rules, the operator screen, the bench and its honest numbers, commands, layout, limits.

**The held-out set, run once and not tuned on** (heuristic backend):

| | scripted (dev) | held-out |
| --- | --- | --- |
| topic shift P / R | 1.00 / 0.95 | **0.00 / 0.00** |
| diversion P / R | 1.00 / 1.00 | **0.50 / 0.20** |
| dodged questions · contradictions | 3/3 · 7/8 | 1/1 · 2/2 |
| ads & crowd · nods · addressed | 1.00 · 1.00 · 1.00 | 1.00 · 1.00 · 1.00 |
| **wrong interruptions** | **0** | **0** |
| responses on time | 15/16 | 8/8 |

Structure generalises; vocabulary does not. The next tuning targets, in order: a transition cue with a subject the
lexicon does not know should open a new line of thought ("Let's move to pensions"); evasion without a change of
subject; whataboutism and attacks in unlisted words; an opposition attack on the record is not whataboutism.
Tune them on real clips, with a fresh held-out split.

**Not measured in this build (no keys; the speech hosts are also blocked from this cloud session):** Claude Haiku as
the Jev backend, Sonnet's time to card, Deepgram and AssemblyAI live. Put the keys in `.env` and run
`npm run bench:report`.

**Tests:** 297 passing. `npm run typecheck` clean. `npm run e2e:capture` OK.
