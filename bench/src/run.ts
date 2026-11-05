/**
 * Play a clip through the listener, chunk by chunk, the way a recognizer
 * would deliver it, and keep every decision next to the truth it was made on.
 */
import { Listener, type Detector, type JevDecision, type Responder, type SpeakerRole } from '@hepta/listen';
import type { Clip } from './clip.js';
import { simulate, type SimChunk, type Simulation, type SimOptions } from './simulate.js';

export type Backend = { name: string; make: (clip: Clip) => Detector };

export type Step = { d: JevDecision; sc: SimChunk };

export type ClipRun = {
  clip: Clip;
  backend: string;
  sim: Simulation;
  steps: Step[];
  /** Engine speaker id → the true speaker behind its recognizer label. */
  truthOf: Record<string, string>;
  listener: Listener;
  wallMs: number;
};

export type RunOptions = SimOptions & {
  /** Name speakers as an operator would, when each first speaks. Default true. */
  names?: boolean;
  /** Writes the response cards. The local template when omitted. */
  responder?: Responder;
};

const ROLES = new Set(['moderator', 'panelist', 'user']);

/** A response fired at the end of a turn belongs to the turn's last utterance. */
function lastFinalOf(steps: Step[], utteranceId: string): SimChunk | undefined {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.d.utteranceId === utteranceId) return steps[i]!.sc;
  return undefined;
}

export async function runClip(clip: Clip, backend: Backend, opts: RunOptions = {}, given?: Simulation & { speech?: number[] }): Promise<ClipRun> {
  const sim = given ?? simulate(clip, opts);
  const listener = new Listener({
    mode: clip.mode, detector: backend.make(clip),
    ...(opts.responder ? { responder: opts.responder } : {}),
    ...(clip.evidence ? { evidence: clip.evidence } : {}),
    ...(clip.stance ? { stance: clip.stance } : {}),
  });
  const named = new Set<string>();
  const steps: Step[] = [];
  const t0 = performance.now();
  // Voice activity, when the recognizer gave it (recorded clips); the simulator's chunk starts stand in for it otherwise.
  const speech = [...(given?.speech ?? [])].sort((a, b) => a - b);
  let si = 0;
  for (const sc of sim.chunks) {
    while (si < speech.length && speech[si]! <= sc.chunk.heardToMs) listener.speechStarted(speech[si++]!);
    if (opts.names !== false) {
      for (const w of sc.chunk.words) {
        const lab = w.speaker;
        if (lab === undefined || lab === null || named.has(lab)) continue;
        named.add(lab);
        const truth = sim.labels[lab]!;
        const info = clip.speakers[truth];
        const id = listener.speakers.idFor(lab);
        if (info && info.role && ROLES.has(info.role)) listener.name(id, info.name, info.role as SpeakerRole);
      }
    }
    // Time passes before this chunk: a response held for the end of a turn may be due.
    const fired = await listener.tick(sc.chunk.startMs);
    if (fired) steps.push({ d: fired, sc: lastFinalOf(steps, fired.utteranceId) ?? sc });
    const d = await listener.hear(sc.chunk);
    steps.push({ d, sc });
  }
  const end = await listener.tick(sim.durationMs + 10_000);
  if (end) steps.push({ d: end, sc: lastFinalOf(steps, end.utteranceId) ?? steps[steps.length - 1]!.sc });
  // Let the response cards finish writing (instant for the template; a model takes its time).
  for (let i = 0; i < 300 && listener.responses.some((r) => r.status === 'writing'); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 0));
  const truthOf: Record<string, string> = {};
  for (const s of listener.speakers.list()) {
    const lab = listener.speakers.labelOf(s.id);
    if (lab !== undefined && sim.labels[lab]) truthOf[s.id] = sim.labels[lab]!;
  }
  return { clip, backend: backend.name, sim, steps, truthOf, listener, wallMs: performance.now() - t0 };
}
