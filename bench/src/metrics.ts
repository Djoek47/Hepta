/**
 * Scoring a run against its labels. Every number the report prints is
 * computed here, from the decisions the listener actually made.
 */
import type { JevDecision } from '@hepta/listen';
import type { ClipTurn } from './clip.js';
import type { ClipRun, Step } from './run.js';

export type PR = { tp: number; fp: number; fn: number };
export const pr = (): PR => ({ tp: 0, fp: 0, fn: 0 });
export const precision = (x: PR) => (x.tp + x.fp === 0 ? null : x.tp / (x.tp + x.fp));
export const recall = (x: PR) => (x.tp + x.fn === 0 ? null : x.tp / (x.tp + x.fn));

export type Miss = { clip: string; turn: string; what: string; detail: string };

export type Metrics = {
  diarization: { words: number; raw: number; engine: number };
  shift: PR & { typeRight: number };
  diversion: PR & { typeRight: number };
  dodged: PR;
  contradiction: PR & { kindRight: number };
  ignore: PR;
  nods: PR;
  addressed: PR;
  respond: {
    expected: number; hit: number; missed: number;
    /** Took the floor where the labels say it should have stayed quiet. */
    outOfTurn: number;
    /** Took the floor while a person was mid-clause. Target 0. */
    wrongInterruptions: number;
    /** Answered before the turn it was answering had ended. */
    tooEarly: number;
  };
  early: { shown: number; right: number; confirmed: number; retracted: number; leadMs: number[] };
  latencyMs: number[];
  detectorMs: number[];
  responseMs: number[];
  misses: Miss[];
};

export function emptyMetrics(): Metrics {
  return {
    diarization: { words: 0, raw: 0, engine: 0 },
    shift: { ...pr(), typeRight: 0 }, diversion: { ...pr(), typeRight: 0 }, dodged: pr(),
    contradiction: { ...pr(), kindRight: 0 }, ignore: pr(), nods: pr(), addressed: pr(),
    respond: { expected: 0, hit: 0, missed: 0, outOfTurn: 0, wrongInterruptions: 0, tooEarly: 0 },
    early: { shown: 0, right: 0, confirmed: 0, retracted: 0, leadMs: [] },
    latencyMs: [], detectorMs: [], responseMs: [], misses: [],
  };
}

const CONTRA_TYPES = new Set(['changed_claim', 'moving_goalposts']);

export function score(run: ClipRun, m: Metrics = emptyMetrics()): Metrics {
  const { clip, steps, sim, truthOf } = run;
  const finals = steps.filter((s) => s.d.final);
  const byTurn = new Map<string, Step[]>();
  for (const s of finals) {
    const list = byTurn.get(s.sc.turnId) ?? [];
    list.push(s);
    byTurn.set(s.sc.turnId, list);
  }
  const miss = (turn: ClipTurn, what: string, detail: string) => m.misses.push({ clip: clip.id, turn: turn.id, what, detail });

  // ---- who spoke
  for (const s of finals) {
    if (s.sc.chunk.event) continue;
    const engineTruth = truthOf[s.d.speaker];
    for (const w of s.sc.truth) {
      m.diarization.words++;
      if (w.speaker !== undefined && w.speaker !== null && sim.labels[w.speaker] === w.truth) m.diarization.raw++;
      if (engineTruth === w.truth) m.diarization.engine++;
    }
  }

  for (const s of steps) {
    m.latencyMs.push(s.d.latencyMs);
    m.detectorMs.push(s.d.detectorMs);
  }

  const dodgedQuestions = new Map<string, string>(); // engine question id → label question id
  for (const turn of clip.turns) {
    const ds = (byTurn.get(turn.id) ?? []).map((s) => s.d);
    const live = ds.filter((d) => !d.ignored);

    // ---- not the conversation
    if (turn.ignore) {
      const all = ds.length > 0 && ds.every((d) => d.ignored === 'ad' || d.ignored === 'crowd');
      if (all) m.ignore.tp++; else { m.ignore.fn++; miss(turn, 'ignore missed', ds.map((d) => d.ignored ?? 'heard').join(',')); }
      continue;
    }
    if (ds.some((d) => d.ignored === 'ad' || d.ignored === 'crowd')) { m.ignore.fp++; miss(turn, 'ignored wrongly', turn.text); }

    if (turn.backchannel) {
      if (ds.length > 0 && ds.every((d) => d.ignored === 'backchannel')) m.nods.tp++;
      else { m.nods.fn++; miss(turn, 'nod taken as a turn', turn.text); }
      continue;
    }
    if (ds.some((d) => d.ignored === 'backchannel')) { m.nods.fp++; miss(turn, 'turn taken as a nod', turn.text); }

    // ---- addressed to Hepta
    const addr = live.some((d) => d.addressedToHepta);
    if (turn.addressed) { if (addr) m.addressed.tp++; else { m.addressed.fn++; miss(turn, 'address missed', turn.text); } }
    else if (addr) { m.addressed.fp++; miss(turn, 'address false', turn.text); }

    // ---- shifts (meta turns are about the programme, not the subject)
    if (!turn.meta) {
      const want = turn.shift ?? 'none';
      const got = live.map((d) => d.shiftType).find((x) => x !== 'none') ?? 'none';
      if (want !== 'none' && got !== 'none') { m.shift.tp++; if (want === got) m.shift.typeRight++; else miss(turn, 'shift type', `${want} → got ${got}`); }
      else if (want !== 'none') { m.shift.fn++; miss(turn, 'shift missed', `${want}: ${turn.text}`); }
      else if (got !== 'none') { m.shift.fp++; miss(turn, 'shift false', `${got}: ${turn.text}`); }
    }

    // ---- diversions (question_dodged is scored as dodges)
    const div = live.map((d) => d.diversion).find((x) => x && x.type !== 'question_dodged');
    const wantDiv = turn.diversion ?? [];
    if (wantDiv.length && div) { m.diversion.tp++; if ((wantDiv as string[]).includes(div.type)) m.diversion.typeRight++; else miss(turn, 'diversion type', `${wantDiv.join('/')} → got ${div.type}`); }
    else if (wantDiv.length) { m.diversion.fn++; miss(turn, 'diversion missed', `${wantDiv.join('/')}: ${turn.text}`); }
    else if (div) { m.diversion.fp++; miss(turn, 'diversion false', `${div.type}: ${turn.text}`); }

    // ---- contradictions
    const flagged = live.find((d) => d.claim?.contradicts || (d.diversion && CONTRA_TYPES.has(d.diversion.type)));
    if (turn.contradicts) {
      if (flagged) {
        m.contradiction.tp++;
        const kind = flagged.claim?.contradicts?.kind ?? flagged.diversion?.type;
        if (kind === turn.contradicts.kind) m.contradiction.kindRight++;
      } else { m.contradiction.fn++; miss(turn, 'contradiction missed', `${turn.contradicts.kind}: ${turn.text}`); }
    } else if (flagged) { m.contradiction.fp++; miss(turn, 'contradiction false', turn.text); }

    // ---- dodged questions: map the engine's question ids to label ids by where they were asked
    for (const d of live) if (d.questionId && turn.question) dodgedQuestions.set(d.questionId, turn.question.id);
  }

  // Dodges: which labelled questions the engine called dodged.
  const calledDodged = new Set<string>();
  for (const s of steps) for (const q of s.d.dodged ?? []) calledDodged.add(dodgedQuestions.get(q) ?? `?${q}`);
  const wantDodged = new Set(clip.turns.filter((t) => t.question?.dodged && !t.question.repeat).map((t) => t.question!.id));
  for (const q of wantDodged) {
    if (calledDodged.has(q)) m.dodged.tp++;
    else { m.dodged.fn++; m.misses.push({ clip: clip.id, turn: q, what: 'dodge missed', detail: q }); }
  }
  for (const q of calledDodged) if (!wantDodged.has(q)) { m.dodged.fp++; m.misses.push({ clip: clip.id, turn: q, what: 'dodge false', detail: q }); }

  scoreTiming(run, m);
  return m;
}

/** When Hepta took the floor, against when the labels say it should have. */
function scoreTiming(run: ClipRun, m: Metrics): void {
  const { clip, steps } = run;
  const turns = new Map(clip.turns.map((t) => [t.id, t]));
  const lastUtterance = new Map<string, string>();
  for (const s of steps) if (s.d.final) lastUtterance.set(s.sc.turnId, s.d.utteranceId);
  const hit = new Set<string>();
  for (const s of steps) {
    if (s.d.respondState !== 'respond') continue;
    const turn = turns.get(s.sc.turnId)!;
    const d: JevDecision = s.d;
    if (!d.final && !d.boundary) {
      m.respond.wrongInterruptions++;
      m.misses.push({ clip: clip.id, turn: turn.id, what: 'WRONG INTERRUPTION', detail: `mid-clause at "${d.text}"` });
      continue;
    }
    const want = turn.hepta ?? 'quiet';
    if (want === 'quiet') {
      m.respond.outOfTurn++;
      m.misses.push({ clip: clip.id, turn: turn.id, what: 'spoke out of turn', detail: `"${d.text}"` });
    } else if (want === 'respond' && !(d.final && lastUtterance.get(turn.id) === d.utteranceId)) {
      m.respond.tooEarly++;
      m.misses.push({ clip: clip.id, turn: turn.id, what: 'too early', detail: `"${d.text}"` });
    } else {
      hit.add(turn.id);
    }
  }
  for (const t of clip.turns) {
    if (t.hepta !== 'respond' && t.hepta !== 'cut') continue;
    m.respond.expected++;
    if (hit.has(t.id)) m.respond.hit++;
    else { m.respond.missed++; m.misses.push({ clip: clip.id, turn: t.id, what: 'response missed', detail: t.text }); }
  }
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export function merge(into: Metrics, m: Metrics): Metrics {
  const add = (a: PR, b: PR) => { a.tp += b.tp; a.fp += b.fp; a.fn += b.fn; };
  into.diarization.words += m.diarization.words; into.diarization.raw += m.diarization.raw; into.diarization.engine += m.diarization.engine;
  add(into.shift, m.shift); into.shift.typeRight += m.shift.typeRight;
  add(into.diversion, m.diversion); into.diversion.typeRight += m.diversion.typeRight;
  add(into.dodged, m.dodged);
  add(into.contradiction, m.contradiction); into.contradiction.kindRight += m.contradiction.kindRight;
  add(into.ignore, m.ignore); add(into.nods, m.nods); add(into.addressed, m.addressed);
  for (const k of Object.keys(into.respond) as (keyof Metrics['respond'])[]) into.respond[k] += m.respond[k];
  into.early.shown += m.early.shown; into.early.right += m.early.right; into.early.confirmed += m.early.confirmed;
  into.early.retracted += m.early.retracted; into.early.leadMs.push(...m.early.leadMs);
  into.latencyMs.push(...m.latencyMs); into.detectorMs.push(...m.detectorMs); into.responseMs.push(...m.responseMs);
  into.misses.push(...m.misses);
  return into;
}
