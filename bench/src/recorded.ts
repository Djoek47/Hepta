/**
 * Real material: a recorded clip (a TV debate) through a real recognizer.
 *
 * The audio is decoded and sent at broadcast speed (or `speed` times faster),
 * and every chunk and voice-activity event the recognizer returns is kept with
 * its audio time. That timeline is cached next to the clip, so the bench can
 * score it again without paying for the transcription twice.
 *
 * Scoring needs the truth for each chunk: the labelled turn it falls in (by
 * time overlap), and for each word, the turn its midpoint falls in. The
 * recognizer's speaker labels are mapped to the true speakers by majority, the
 * way an operator would name them after hearing them.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { decodeAudio, pace, type SttChunk, type SttProvider } from '@hepta/listen';
import type { Clip, ClipTurn } from './clip.js';
import type { SimChunk, Simulation, TruthWord } from './simulate.js';

export type Timeline = { provider: string; audio: string; size: number; mtimeMs: number; chunks: SttChunk[]; speech: number[] };

/** Transcribe the clip's audio, or read the cached timeline. */
export async function transcribe(clip: Clip, clipDir: string, provider: SttProvider, opts: { speed?: number; fresh?: boolean; log?: (s: string) => void } = {}): Promise<Timeline> {
  if (!clip.audio) throw new Error(`${clip.id}: no audio`);
  const audio = resolve(clipDir, clip.audio);
  const st = statSync(audio);
  const cache = join(clipDir, `.stt-${provider.name}.json`);
  if (!opts.fresh && existsSync(cache)) {
    const t = JSON.parse(readFileSync(cache, 'utf8')) as Timeline;
    if (t.size === st.size && t.mtimeMs === st.mtimeMs) return t;
  }
  const pcm = await decodeAudio(audio);
  opts.log?.(`  transcribing ${clip.id}: ${(pcm.length / 16000).toFixed(0)} s through ${provider.name} at ${opts.speed ?? 1}×`);
  const session = await provider.open({ sampleRate: 16_000 });
  const chunks: SttChunk[] = [];
  const speech: number[] = [];
  session.on((e) => {
    if (e.type === 'chunk') chunks.push(e.chunk);
    else if (e.type === 'speech') speech.push(e.atMs);
    else if (e.type === 'error') opts.log?.(`  ${e.error}`);
  });
  await pace(pcm, (f) => session.send(f), { speed: opts.speed ?? 1 });
  await session.finish();
  const t: Timeline = { provider: provider.name, audio: clip.audio, size: st.size, mtimeMs: st.mtimeMs, chunks, speech };
  writeFileSync(cache, JSON.stringify(t));
  return t;
}

/** The turn a span of audio belongs to: most overlap, else the nearest. */
function turnAt(turns: ClipTurn[], start: number, end: number): ClipTurn {
  let best: ClipTurn | null = null;
  let bestOverlap = 0;
  for (const t of turns) {
    const o = Math.min(end, t.endMs!) - Math.max(start, t.startMs!);
    if (o > bestOverlap) { bestOverlap = o; best = t; }
  }
  if (best) return best;
  const mid = (start + end) / 2;
  return turns.reduce((a, b) => (Math.abs((a.startMs! + a.endMs!) / 2 - mid) <= Math.abs((b.startMs! + b.endMs!) / 2 - mid) ? a : b));
}

/** A transcribed timeline, as the scoring code expects a simulation. */
export function alignTimeline(clip: Clip, t: Timeline): Simulation {
  const turns = clip.turns.filter((x) => x.startMs !== undefined && x.endMs !== undefined);
  if (turns.length === 0) throw new Error(`${clip.id}: recorded clips need startMs/endMs on their turns`);
  const co = new Map<string, Map<string, number>>();
  const chunks: SimChunk[] = t.chunks.map((chunk) => {
    const turn = turnAt(turns, chunk.startMs, chunk.endMs);
    const truth: TruthWord[] = chunk.words.map((w) => {
      const tw = turnAt(turns, w.startMs, w.endMs);
      if (chunk.final && w.speaker !== undefined && w.speaker !== null) {
        const m = co.get(w.speaker) ?? new Map<string, number>();
        m.set(tw.speaker, (m.get(tw.speaker) ?? 0) + 1);
        co.set(w.speaker, m);
      }
      return { ...w, truth: tw.speaker, turnId: tw.id };
    });
    return { chunk, turnId: turn.id, truthSpeaker: turn.speaker, truth };
  });
  const labels: Record<string, string> = {};
  for (const [label, m] of co) labels[label] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const utteranceTurn: Record<string, string> = {};
  for (const c of chunks) utteranceTurn[c.chunk.utteranceId] = c.turnId;
  const turnTimes = Object.fromEntries(turns.map((x) => [x.id, { startMs: x.startMs!, endMs: x.endMs! }]));
  return { chunks, labels, utteranceTurn, turnTimes, durationMs: Math.max(...turns.map((x) => x.endMs!), 0) };
}

/** A first draft of clip.json from a transcription: turns with times and text, labels left for a person. */
export function draftClip(id: string, audio: string, t: Timeline, mode: Clip['mode']): Clip {
  const finals = t.chunks.filter((c) => c.final);
  const ids = new Map<string, string>();
  const sid = (label: string) => { if (!ids.has(label)) ids.set(label, `S${ids.size + 1}`); return ids.get(label)!; };
  const turns: ClipTurn[] = [];
  for (const c of finals) {
    const votes = new Map<string, number>();
    for (const w of c.words) if (w.speaker !== undefined && w.speaker !== null) votes.set(w.speaker, (votes.get(w.speaker) ?? 0) + 1);
    const label = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?';
    const speaker = sid(label);
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker && c.startMs - last.endMs! < 1500) {
      last.text += ' ' + c.text;
      last.endMs = c.endMs;
    } else {
      turns.push({ id: `t${turns.length + 1}`, speaker, text: c.text, startMs: c.startMs, endMs: c.endMs, topic: '', shift: 'none' });
    }
  }
  return {
    id, title: id, mode, audio,
    note: 'Draft from a transcription. Check speakers and times, name the speakers, and label each turn (see bench/clips/README.md).',
    speakers: Object.fromEntries([...ids.values()].map((s) => [s, { name: s, role: 'panelist' as const }])),
    turns,
  };
}

export function clipDirOf(path: string): string {
  return dirname(path);
}
