/**
 * Play a clip through the listener, chunk by chunk, the way a recognizer
 * would deliver it, and keep every decision next to the truth it was made on.
 */
import { Listener, type Detector, type JevDecision, type SpeakerRole } from '@hepta/listen';
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
};

const ROLES = new Set(['moderator', 'panelist', 'user']);

export async function runClip(clip: Clip, backend: Backend, opts: RunOptions = {}): Promise<ClipRun> {
  const sim = simulate(clip, opts);
  const listener = new Listener({
    mode: clip.mode, detector: backend.make(clip),
    ...(clip.evidence ? { evidence: clip.evidence } : {}),
    ...(clip.stance ? { stance: clip.stance } : {}),
  });
  const named = new Set<string>();
  const steps: Step[] = [];
  const t0 = performance.now();
  for (const sc of sim.chunks) {
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
    const d = await listener.hear(sc.chunk);
    steps.push({ d, sc });
  }
  const truthOf: Record<string, string> = {};
  for (const s of listener.speakers.list()) {
    const lab = listener.speakers.labelOf(s.id);
    if (lab !== undefined && sim.labels[lab]) truthOf[s.id] = sim.labels[lab]!;
  }
  return { clip, backend: backend.name, sim, steps, truthOf, listener, wallMs: performance.now() - t0 };
}
