/**
 * A streaming recognizer, simulated from a script.
 *
 * What a real one delivers, it delivers: the utterance so far every couple of
 * words, finals when a sentence ends in a pause, punctuation as it goes, word
 * timings, and a diarization label per word. And the mistakes a real one
 * makes, seeded so a run is repeatable:
 *
 *   onset lag   the first word or two of a new speaker carry the previous label
 *   flicker     a single word carries a wrong label
 *   revisions   a word is misheard in a partial and corrected in the next
 *
 * The truth for every word is kept alongside, so the bench can score who was
 * heard against who spoke.
 */
import { sentences } from '../text.js';
import type { SttChunk, Word } from '../types.js';
import type { Clip, ClipTurn } from '../clip.js';

export type SimOptions = {
  seed?: number;
  onsetLag?: number;
  flicker?: number;
  revisions?: number;
  /** Words per partial. */
  wordsPerPartial?: number;
  /** A pause at least this long ends an utterance. */
  endpointMs?: number;
};

export type TruthWord = Word & { truth: string; turnId: string };

export type SimChunk = {
  chunk: SttChunk;
  /** The turn this utterance belongs to. */
  turnId: string;
  truthSpeaker: string;
  /** Every word in the chunk, with who really said it. */
  truth: TruthWord[];
};

export type Simulation = {
  chunks: SimChunk[];
  /** Recognizer label → the true speaker who owns it (what an operator would name). */
  labels: Record<string, string>;
  /** Utterance id → turn id. */
  utteranceTurn: Record<string, string>;
  /** Where each turn sits in the audio. */
  turnTimes: Record<string, { startMs: number; endMs: number }>;
  durationMs: number;
};

const MISHEAR: Record<string, string> = {
  for: 'four', funded: 'founded', homes: 'homs', crime: 'time', growth: 'grow', tax: 'tacks', meals: 'meels',
  waiting: 'weighting', minister: 'minster', billion: 'million', rail: 'rel', bills: 'builds', profits: 'prophets',
};

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentencesOf(text: string): string[] {
  return sentences(text);
}

export function simulate(clip: Clip, opts: SimOptions = {}): Simulation {
  const r = rng(opts.seed ?? clip.noise?.seed ?? hash(clip.id));
  const onsetLag = opts.onsetLag ?? clip.noise?.onsetLag ?? 0.15;
  const flicker = opts.flicker ?? clip.noise?.flicker ?? 0.02;
  const revisions = opts.revisions ?? clip.noise?.revisions ?? 0.1;
  const per = opts.wordsPerPartial ?? 2;

  const labels: Record<string, string> = {};
  const labelOf = new Map<string, string>();
  const label = (speaker: string) => {
    let l = labelOf.get(speaker);
    if (l === undefined) {
      l = String(labelOf.size);
      labelOf.set(speaker, l);
      labels[l] = speaker;
    }
    return l;
  };

  const chunks: SimChunk[] = [];
  const utteranceTurn: Record<string, string> = {};
  const turnTimes: Record<string, { startMs: number; endMs: number }> = {};
  let t = 400;
  /** When the next turn may start without talking over anyone. */
  let cursor = 400;
  /** The last word anyone said, for crosstalk. */
  let lastWordEnd = 400;
  let prevLabel: string | null = null;
  let uSeq = 0;

  for (const turn of clip.turns) {
    const sp = clip.speakers[turn.speaker] ?? {};
    const myLabel = label(turn.speaker);
    const gap = 250 + r() * 400;
    t = turn.overlapMs ? Math.max(0, lastWordEnd - turn.overlapMs) : cursor + gap;
    if (turn.startMs !== undefined) t = turn.startMs;
    const turnStart = t;

    if (turn.ignore === 'crowd' || /^\[.*\]$/.test(turn.text.trim())) {
      const dur = 1800 + r() * 1200;
      const uid = `sim-u${++uSeq}`;
      utteranceTurn[uid] = turn.id;
      const w: TruthWord = { text: turn.text, startMs: t, endMs: t + dur, speaker: myLabel, truth: turn.speaker, turnId: turn.id };
      chunks.push({
        chunk: { utteranceId: uid, text: turn.text, final: true, words: [stripTruth(w)], startMs: t, endMs: t + dur, heardToMs: t + dur + 300, event: /laugh/i.test(turn.text) ? 'laughter' : 'applause' },
        turnId: turn.id, truthSpeaker: turn.speaker, truth: [w],
      });
      turnTimes[turn.id] = { startMs: t, endMs: t + dur };
      t += dur;
      cursor = Math.max(cursor, t);
      continue;
    }

    const msPerWord = 60_000 / (sp.wpm ?? 170);
    let firstWordsOfTurn = 0;
    const lagWords = prevLabel !== null && prevLabel !== myLabel && r() < onsetLag ? (r() < 0.5 ? 1 : 2) : 0;
    for (const sentence of sentencesOf(turn.text)) {
      const uid = `sim-u${++uSeq}`;
      utteranceTurn[uid] = turn.id;
      const tokens = sentence.split(/\s+/);
      const words: TruthWord[] = [];
      for (const tok of tokens) {
        const dur = msPerWord * (0.75 + r() * 0.5) * Math.max(0.6, Math.min(1.8, tok.replace(/[^a-z0-9]/gi, '').length / 5));
        let lab = myLabel;
        if (firstWordsOfTurn < lagWords && prevLabel !== null) lab = prevLabel;
        else if (r() < flicker && labelOf.size > 1) {
          const others = [...labelOf.values()].filter((x) => x !== myLabel && labels[x] !== 'AD' && labels[x] !== 'CROWD');
          if (others.length) lab = others[Math.floor(r() * others.length)]!;
        }
        firstWordsOfTurn++;
        words.push({ text: tok, startMs: Math.round(t), endMs: Math.round(t + dur), speaker: lab, confidence: 0.9, truth: turn.speaker, turnId: turn.id });
        t += dur;
        if (/,$/.test(tok)) t += 180 + r() * 120;
        else t += 20 + r() * 60;
      }
      // Partials every few words; a revision now and then.
      const revAt = r() < revisions ? 1 + Math.floor(r() * Math.max(1, words.length - 2)) : -1;
      for (let n = per; n < words.length; n += per) {
        const shown = words.slice(0, n).map((w, i) => {
          const wrong = i === revAt && n - 1 === revAt ? MISHEAR[w.text.toLowerCase().replace(/[^a-z]/g, '')] : undefined;
          return wrong ? { ...w, text: wrong } : w;
        });
        const last = shown[shown.length - 1]!;
        chunks.push({
          chunk: { utteranceId: uid, text: shown.map((w) => w.text).join(' '), final: false, words: shown.map(stripTruth),
            startMs: words[0]!.startMs, endMs: last.endMs, heardToMs: last.endMs + 60 + Math.round(r() * 60) },
          turnId: turn.id, truthSpeaker: turn.speaker, truth: shown,
        });
      }
      const last = words[words.length - 1]!;
      chunks.push({
        chunk: { utteranceId: uid, text: sentence, final: true, words: words.map(stripTruth), startMs: words[0]!.startMs, endMs: last.endMs, heardToMs: last.endMs + 320 },
        turnId: turn.id, truthSpeaker: turn.speaker, truth: words,
      });
      lastWordEnd = Math.max(lastWordEnd, last.endMs);
      t += 380 + r() * 220; // a sentence-final pause: the recognizer's endpoint
    }
    turnTimes[turn.id] = { startMs: turnStart, endMs: t };
    cursor = Math.max(cursor, t);
    prevLabel = myLabel;
  }
  // Overlapping turns make chunks out of order in time; a recognizer delivers them in time order.
  chunks.sort((a, b) => a.chunk.heardToMs - b.chunk.heardToMs);
  return { chunks, labels, utteranceTurn, turnTimes, durationMs: cursor };
}

function stripTruth(w: TruthWord): Word {
  const { truth: _t, turnId: _id, ...rest } = w;
  return rest;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function turnById(clip: Clip): Map<string, ClipTurn> {
  return new Map(clip.turns.map((t) => [t.id, t]));
}

// ------------------------------------------------------------- as a provider

/**
 * A scripted clip as a recognizer: the simulated chunks, delivered at the
 * times they would have arrived (divided by `speed`). Audio sent to it is
 * ignored. This is how the UI plays a labelled clip with no keys at all.
 */
export function scriptedProvider(clip: Clip, opts: SimOptions & { speed?: number } = {}): import('./provider.js').SttProvider {
  return {
    name: 'scripted',
    diarizes: 'word',
    async open() {
      const { Emitter } = await import('./provider.js');
      const ev = new Emitter();
      const sim = simulate(clip, opts);
      const speed = Math.max(0.1, opts.speed ?? 1);
      const timers: ReturnType<typeof setTimeout>[] = [];
      let closed = false;
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((r) => { resolveDone = r; });
      const t0 = sim.chunks[0]?.chunk.heardToMs ?? 0;
      queueMicrotask(() => {
        ev.emit({ type: 'open' });
        // Voice activity, as a recognizer's VAD reports it: when each utterance starts, before its words.
        const started = new Set<string>();
        for (const sc of sim.chunks) {
          if (started.has(sc.chunk.utteranceId)) continue;
          started.add(sc.chunk.utteranceId);
          const at = sc.chunk.startMs;
          timers.push(setTimeout(() => { if (!closed) ev.emit({ type: 'speech', atMs: at }); }, Math.max(0, (at - t0) / speed)));
        }
        sim.chunks.forEach((sc, i) => {
          timers.push(setTimeout(() => {
            if (closed) return;
            ev.emit({ type: 'chunk', chunk: sc.chunk });
            if (i === sim.chunks.length - 1) { ev.emit({ type: 'close', reason: 'end of clip' }); resolveDone(); }
          }, Math.max(0, (sc.chunk.heardToMs - t0) / speed)));
        });
        if (sim.chunks.length === 0) resolveDone();
      });
      const stop = () => { closed = true; for (const t of timers) clearTimeout(t); resolveDone(); };
      return {
        send() {},
        async finish() { await done; },
        close() { if (!closed) { stop(); ev.emit({ type: 'close', reason: 'stopped' }); } },
        on: (fn) => ev.on(fn),
      };
    },
  };
}
