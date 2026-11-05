import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeuristicDetector, scriptedProvider, simulate } from '@hepta/listen';
import type { Clip } from '../src/clip.js';
import { alignTimeline, draftClip, transcribe } from '../src/recorded.js';
import { runClip } from '../src/run.js';
import { score } from '../src/metrics.js';

/** A scripted clip dressed as a recording: turns with times, a silent audio file, and a "recognizer" that plays the script. */
function recordedFrom(id: string) {
  const clip = JSON.parse(readFileSync(new URL(`../clips/${id}.json`, import.meta.url), 'utf8')) as Clip;
  const sim = simulate(clip);
  const turns = clip.turns.map((t) => ({ ...t, ...sim.turnTimes[t.id]! }));
  const dir = mkdtempSync(join(tmpdir(), 'hepta-rec-'));
  const n = 16000;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  writeFileSync(join(dir, 'audio.wav'), b);
  return { clip: { ...clip, audio: 'audio.wav', turns } as Clip, dir, scripted: clip };
}

describe('recorded clips', () => {
  it('aligns what a recognizer heard with the labelled turns by time, and scores like a scripted clip', async () => {
    const { clip, dir, scripted } = recordedFrom('01-panel-housing');
    const t = await transcribe(clip, dir, scriptedProvider(scripted, { speed: 2000 }), { speed: 200 });
    expect(t.chunks.length).toBeGreaterThan(20);
    expect(t.speech.length).toBeGreaterThan(5);
    const sim = { ...alignTimeline(clip, t), speech: t.speech };
    expect(sim.labels['0']).toBe('MOD');
    const backend = { name: 'heuristic', make: () => new HeuristicDetector() };
    const recorded = score(await runClip(clip, backend, {}, sim));
    const direct = score(await runClip(scripted, backend));
    expect(recorded.shift).toEqual(direct.shift);
    expect(recorded.diversion).toEqual(direct.diversion);
    expect(recorded.dodged).toEqual(direct.dodged);
    expect(recorded.respond.wrongInterruptions).toBe(0);
    expect(recorded.diarization.engine / recorded.diarization.words).toBeGreaterThan(0.95);
  });

  it('reads a cached transcription instead of paying for it twice', async () => {
    const { clip, dir, scripted } = recordedFrom('09-panel-schools-cooperative');
    await transcribe(clip, dir, scriptedProvider(scripted, { speed: 2000 }), { speed: 200 });
    const never = { name: 'scripted', diarizes: 'word' as const, open: () => { throw new Error('should not transcribe again'); } };
    const again = await transcribe(clip, dir, never);
    expect(again.chunks.length).toBeGreaterThan(10);
  });

  it('drafts a clip.json from a transcription, turns grouped by speaker, labels left blank', async () => {
    const { clip, dir, scripted } = recordedFrom('09-panel-schools-cooperative');
    const t = await transcribe(clip, dir, scriptedProvider(scripted, { speed: 2000 }), { speed: 200 });
    const draft = draftClip('my-clip', 'audio.wav', t, 'panel');
    expect(Object.keys(draft.speakers)).toEqual(['S1', 'S2', 'S3']);
    expect(draft.turns.length).toBeGreaterThanOrEqual(8);
    expect(draft.turns[0]).toMatchObject({ speaker: 'S1', shift: 'none', topic: '' });
    expect(draft.turns.every((x) => x.startMs! < x.endMs!)).toBe(true);
  });
});
