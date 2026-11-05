# Hepta Listen — bench report

Generated 2026-11-05 07:39 UTC at commit `c05ceb9` with `npm run bench:report`.
Node v22.23.4. Every number below is computed from decisions the listener made on the clips; definitions at the end.

## How to read this

- **Scripted set (development).** 10 clips, 111 turns, labelled *before* any detector existed — but the heuristic
  rules were then tuned against their misses (steps 2–7). They are a development set: they show the rules do what
  they were built to do, not how well they generalise.
- **Held-out set.** 4 clips, 40 turns, written after step 4 with phrasings no cue lists, and **never tuned on**:
  run for the first time for this report, and no code was changed after seeing it. This is the honest number for
  the heuristic on material it has not seen. Real TV clips (recorded clips, below) are the real test.
- **jev-haiku** (Claude Haiku as the Jev backend) and **Sonnet response cards** run only with `ANTHROPIC_API_KEY`;
  recorded clips only with `DEEPGRAM_API_KEY` or `ASSEMBLYAI_API_KEY`. Without keys those columns say so —
  nothing is estimated.

## Scripted set (development)

| | heuristic | jev-haiku | |
|---|---|---|---|
| diarization accuracy (words) | 99.8% (recognizer 95.8%) | not run |  |
| topic shift P / R | 1.00 / 0.95 | not run |  |
| shift type right | 19/19 | not run |  |
| diversion P / R | 1.00 / 1.00 | not run |  |
| diversion type right | 10/10 | not run |  |
| dodged questions P / R | 1.00 / 1.00  (tp 3 fp 0 fn 0) | not run |  |
| contradictions P / R | 1.00 / 0.88  (tp 7 fp 0 fn 1) | not run |  |
| ads & crowd ignored P / R | 1.00 / 1.00 | not run |  |
| nods are not turns P / R | 1.00 / 1.00 | not run |  |
| addressed to Hepta P / R | 1.00 / 1.00 | not run |  |
| WRONG INTERRUPTIONS | 0 | not run | target 0: took the floor mid-clause |
| responses on time | 15/16 | not run |  |
| spoke out of turn / too early | 0 / 0 | not run |  |
| decision latency median / p95 | 0.15 ms / 0.76 ms | not run | target < 150 ms per decision |
| detector alone median / p95 | 0.10 ms / 0.43 ms | not run |  |
| response card median / p95 | 0.16 ms / 1.05 ms | not run | target < 1.5 s to the card |
| early insights right | 8/8 (100.0%) | not run | provisional cards on half a sentence that the labels bear out |
| confirmed / retracted | 8 / 0 | not run |  |
| shown ahead of the sentence end | 2699 ms median | not run |  |

**jev-haiku:** not run: set ANTHROPIC_API_KEY in .env to bench Claude Haiku.

## Held-out set (never tuned on)

| | heuristic | jev-haiku | |
|---|---|---|---|
| diarization accuracy (words) | 100.0% (recognizer 97.7%) | not run |  |
| topic shift P / R | 0.00 / 0.00 | not run |  |
| shift type right | 0/0 | not run |  |
| diversion P / R | 0.50 / 0.20 | not run |  |
| diversion type right | 1/1 | not run |  |
| dodged questions P / R | 1.00 / 1.00  (tp 1 fp 0 fn 0) | not run |  |
| contradictions P / R | 1.00 / 1.00  (tp 2 fp 0 fn 0) | not run |  |
| ads & crowd ignored P / R | 1.00 / 1.00 | not run |  |
| nods are not turns P / R | 1.00 / 1.00 | not run |  |
| addressed to Hepta P / R | 1.00 / 1.00 | not run |  |
| WRONG INTERRUPTIONS | 0 | not run | target 0: took the floor mid-clause |
| responses on time | 8/8 | not run |  |
| spoke out of turn / too early | 0 / 0 | not run |  |
| decision latency median / p95 | 0.18 ms / 0.92 ms | not run | target < 150 ms per decision |
| detector alone median / p95 | 0.12 ms / 0.74 ms | not run |  |
| response card median / p95 | 0.14 ms / 1.02 ms | not run | target < 1.5 s to the card |
| early insights right | 1/2 (50.0%) | not run | provisional cards on half a sentence that the labels bear out |
| confirmed / retracted | 2 / 0 | not run |  |
| shown ahead of the sentence end | 2291 ms median | not run |  |

**jev-haiku:** not run: set ANTHROPIC_API_KEY in .env to bench Claude Haiku.

### What the held-out set got wrong (the next tuning targets)

- `h1-panel-defence` t2 — **diversion missed**: deflection: We're investing more than any government in a generation.
- `h1-panel-defence` t4 — **diversion missed**: deflection: Look, the threats we face are real, and our armed forces know we have their backs.
- `h1-panel-defence` t5 — **shift false**: diversion: Your party cut the army to its smallest size in two hundred years.
- `h1-panel-defence` t5 — **diversion false**: whataboutism: Your party cut the army to its smallest size in two hundred years.
- `h1-panel-defence` t6 — **shift missed**: diversion: And when your lot were in charge, you let the navy rot in port.
- `h1-panel-defence` t6 — **diversion missed**: whataboutism: And when your lot were in charge, you let the navy rot in port.
- `h1-panel-defence` t8 — **shift missed**: natural: Let's move to pensions, because many of you wrote in about this. Opposition spokesperson, would you keep the triple lock?
- `h1-panel-defence` t5 — **early card confirmed**: whataboutism on "Your party cut the army to its smallest size in two hundred years."
- `h2-conversation-marathon` t7 — **shift missed**: follow_up: And what should I eat the night before?
- `h3-panel-social-media` t4 — **shift missed**: diversion: With respect, the campaigner has never had to run a government department.
- `h3-panel-social-media` t4 — **diversion missed**: ad_hominem: With respect, the campaigner has never had to run a government department.
- `h3-panel-social-media` t5 — **shift missed**: follow_up: That's not an answer.
- `h3-panel-social-media` t6 — **shift missed**: natural: Let's bring in the audience question on screen time. How much screen time is too much for a ten year old?
- `h4-debater-farming` t7 — **shift missed**: follow_up: Because food security has to come first in a crisis, the land should grow food.

Read together: the rules that rest on **structure** generalise — counting a question's turns, comparing figures,
the evidence pack, ads, crowd and nods, who is addressed, and the timing (no wrong interruptions, every response
on time). The rules that rest on **vocabulary** do not: a move to a subject the lexicon does not know is not seen
as a move (a transition cue with an unknown subject should open a new line of thought — the clearest fix), and
evasions, whataboutism and attacks in words no cue lists are missed, while an opposition attack on the record was
read as whataboutism. That is the gap the Haiku backend is for, and what real clips should tune next — with a
fresh held-out split.

## Recorded clips (real TV material)

None yet. Add yours with `npm run bench:draft -- --audio <file> --id <name>`, label the draft (`bench/clips/README.md`), and they join the bench: transcribed once at broadcast speed through Deepgram or AssemblyAI, cached, aligned to your labels by time, and scored like every other clip.

## Per clip

### Scripted set
**heuristic**

| clip | shift P/R | diversion P/R | dodges P/R | contradictions P/R | wrong interruptions | responses |
|---|---|---|---|---|---|---|
| 01-panel-housing | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | — / — | 0 | 1/1 |
| 02-panel-economy | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0 | 1/1 |
| 03-debater-netzero | 1.00 / 0.50 | — / — | — / — | 1.00 / 1.00 | 0 | 3/3 |
| 04-conversation-savings | 1.00 / 1.00 | 1.00 / 1.00 | — / — | 1.00 / 1.00 | 0 | 3/3 |
| 05-panel-health-goalposts | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0 | 1/1 |
| 06-panel-crosstalk | — / — | — / — | — / — | — / — | 0 | 1/1 |
| 07-panel-ad-break | — / — | — / — | — / — | — / — | 0 | 1/1 |
| 08-debater-fourday | 1.00 / 1.00 | 1.00 / 1.00 | — / — | 1.00 / 0.50 | 0 | 3/4 |
| 09-panel-schools-cooperative | 1.00 / 1.00 | — / — | — / — | — / — | 0 | 0/0 |
| 10-panel-fragments | 1.00 / 1.00 | 1.00 / 1.00 | — / — | — / — | 0 | 1/1 |

### Held-out set
**heuristic**

| clip | shift P/R | diversion P/R | dodges P/R | contradictions P/R | wrong interruptions | responses |
|---|---|---|---|---|---|---|
| h1-panel-defence | 0.00 / 0.00 | 0.00 / 0.00 | 1.00 / 1.00 | — / — | 0 | 1/1 |
| h2-conversation-marathon | — / 0.00 | 1.00 / 1.00 | — / — | 1.00 / 1.00 | 0 | 3/3 |
| h3-panel-social-media | — / 0.00 | — / 0.00 | — / — | — / — | 0 | 1/1 |
| h4-debater-farming | — / 0.00 | — / — | — / — | 1.00 / 1.00 | 0 | 3/3 |

## Definitions

| metric | what is counted |
| --- | --- |
| diarization accuracy | Words in finished utterances attributed to their true speaker after the listener's majority vote over each utterance. "recognizer" is the same count on the raw per-word labels. |
| topic shift P / R | Per labelled turn (cues to Hepta, ads, crowd and nods excluded): a shift predicted (not `none`) against a shift labelled. "type right" counts true positives with the same type (natural / follow-up / diversion). |
| diversion P / R | Per turn: any diversion except question-dodged, against the turn's labelled diversion types. "type right": the predicted type is one the label allows. |
| dodged questions | Per labelled question marked dodged: did the listener call that question dodged (matched by where it was asked)? |
| contradictions | Per turn labelled as contradicting an earlier claim of the same speaker or the evidence pack: was a contradiction flagged on it? |
| ads & crowd / nods / addressed | Turns labelled ignore, backchannel, addressed: P / R of the listener's call on them. |
| **wrong interruptions** | Responses decided while a person was mid-clause (not at a clause boundary, not at the end of a sentence). Target 0. |
| responses on time | Turns labelled respond (answer when the turn ends) or cut (may take the floor at a clause boundary) where Hepta answered at an allowed moment. "out of turn": an answer in a turn labelled quiet. "too early": before the turn's last sentence had ended. |
| decision latency | Wall time per chunk: detector plus rules. "detector alone" excludes the rules. Target < 150 ms. |
| response card | Wall time from the decision to respond to the first words on the card. Target < 1.5 s. |
| early insights | Cards shown on half a sentence (provisional). "right": the turn's labels contain that diversion or contradiction. "shown ahead": how long before the sentence ended. |
