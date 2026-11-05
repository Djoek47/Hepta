# Bench clips

Every `.json` file here is a scripted clip; every folder with a `clip.json` is a **recorded clip** (real audio).
`bench/holdout/` holds the held-out set: never tune rules against it.

## Adding a TV clip

```bash
npm run bench:draft -- --audio ~/clips/question-time.mp4 --id question-time-oct --mode panel
```

This copies the audio to `bench/clips/question-time-oct/`, transcribes it once at broadcast speed through Deepgram
or AssemblyAI (cached in `.stt-<provider>.json`, git-ignored), and writes a draft `clip.json`: one turn per run of
one speaker, with `startMs`, `endMs` and the words. Then:

1. **Speakers.** Rename `S1`, `S2`… to whatever you like (`MOD`, `MIN`…) in `speakers` and in every turn; give each
   a `name` and a `role` (`moderator`, `panelist`, or `user`). Mark an ad voice `"role": "ad"` and audience noise
   `"role": "crowd"`.
2. **Check the turns.** Merge or split where the recognizer got the speaker or the boundary wrong; fix times if
   needed (milliseconds from the start of the audio). Truth comes from your turns, not from the recognizer.
3. **Label** (all optional except `id`, `speaker`, `text`, `startMs`, `endMs`):

| field | meaning |
| --- | --- |
| `topic` | The subject of the turn, in your words. Only changes are scored. |
| `shift` | How the subject moved from the previous conversational turn: `none` (default), `natural` (a cue, the moderator moving on), `follow_up` (connected, or a return to an open line), `diversion` (away from an open question or the point: a deflection that changes the subject, whataboutism, ad hominem). |
| `diversion` | The diversion types any of which is a correct reading: `deflection`, `whataboutism`, `ad_hominem`, `moving_goalposts`, `changed_claim`. (A dodge is labelled on the question, not here.) |
| `question` | `{ "id": "q1", "to": "MIN" }` — this turn asks a question of someone (`to: null` for the whole panel). Add `"repeat": true` when it asks an earlier one again (same `id`), and `"dodged": true` on the first asking if the person never answers it within two of their turns. |
| `answers` | `"q1"` — this turn answers that question. |
| `claim` | `{ "id": "c1", "subject": "growth", "value": 3, "unit": "%", "kind": "fact" }` (or `"commitment"`). |
| `contradicts` | `{ "of": "c1", "kind": "changed_claim" }` (same speaker, earlier claim), `"moving_goalposts"`, or `{ "of": "e1", "kind": "evidence" }` (an item in `evidence`). |
| `ignore` | `"ad"` or `"crowd"`: not part of the conversation. |
| `backchannel` | `true` for a nod: "yeah", "mm", "right". Not a turn. |
| `addressed` | `true` when the turn speaks to Hepta (a direct question, the moderator's cue). |
| `meta` | `true` for programme talk ("back after the break") and cues: not scored for shifts. |
| `hepta` | What Hepta should do: `respond` (answer when this turn ends), `cut` (may take the floor at a clause boundary in this turn), `quiet` (default — any answer here is out of turn). In a panel, only cues and direct questions are `respond`. |

Clip-level fields: `mode` (`conversation`, `debater`, `panel`), `evidence` (items with `id`, `subject`, `keys`,
`value`, `unit`, `text`, `source`, optional `tolerance`), `stance` (debater: `topic`, `keys`, `position`,
`confidence`, `evidence`), `dodgeTurns` (default 2), `noise` (scripted clips only: `seed`, `onsetLag`, `flicker`,
`revisions`).

4. Run `npm run bench`. Recorded clips are scored like scripted ones; `npm run bench -- --clips question-time
--misses` lists every disagreement with your labels.

Keep some real clips out of tuning (a folder you only run for reports), or the numbers will flatter.
