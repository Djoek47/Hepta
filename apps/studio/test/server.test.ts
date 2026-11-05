import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startStudio } from '../src/server.js';
import { Session } from '../src/session.js';
import { Downsampler } from '../web/downsample.js';
import type { SttProvider, SttChunk } from '@hepta/listen';

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: Record<string, unknown>[] = [];
  const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Record<string, unknown>;
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const until = (pred: (m: Record<string, unknown>) => boolean, ms = 8000) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const hit = msgs.find(pred);
    if (hit) return resolve(hit);
    waiters.push({ pred, resolve });
    setTimeout(() => reject(new Error('timed out waiting for a message')), ms);
  });
  return { ws, msgs, until, opened: new Promise((r) => ws.on('open', r)) };
}

describe('the studio server', () => {
  it('says which keys exist without sending any, and plays a scripted clip through the listener', async () => {
    const s = await startStudio({ env: { ANTHROPIC_API_KEY: 'sk-secret' }, publicDir: 'apps/studio/public', clipsDir: 'bench/clips', port: 0 });
    close = s.close;
    const c = client(s.port);
    const hello = await c.until((m) => m.type === 'hello');
    expect(hello.keys).toEqual({ anthropic: true, deepgram: false, assemblyai: false });
    expect(JSON.stringify(hello)).not.toContain('sk-secret');
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'start', input: 'script', clip: '01-panel-housing', speed: 400 }));
    const respond = await c.until((m) => m.type === 'decision' && (m.decision as { respondState: string }).respondState === 'respond', 15000);
    expect((respond.decision as { text: string }).text).toMatch(/Hepta/);
    const speakers = respond.speakers as { id: string; name?: string }[];
    expect(speakers.find((x) => x.name === 'Moderator')).toBeDefined();
    c.ws.close();
  });

  it('carries audio frames from the page to the recognizer', async () => {
    const got: number[] = [];
    const fake: SttProvider = {
      name: 'fake', diarizes: 'word',
      async open() {
        let fn: ((e: { type: 'chunk'; chunk: SttChunk }) => void) | null = null;
        return {
          send(pcm) {
            got.push(pcm.length);
            fn?.({ type: 'chunk', chunk: { utteranceId: 'u1', text: 'Hepta, are you there?', final: true, words: [{ text: 'Hepta,', startMs: 0, endMs: 300, speaker: '0' }], startMs: 0, endMs: 300, heardToMs: 600 } });
          },
          async finish() {}, close() {},
          on(f) { fn = f as typeof fn; return () => { fn = null; }; },
        };
      },
    };
    const s = await startStudio({ env: {}, publicDir: 'apps/studio/public', clipsDir: 'bench/clips', port: 0,
      session: (send, clips) => new Session(send, {}, clips, () => fake) });
    close = s.close;
    const c = client(s.port);
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'start', input: 'mic', mode: 'conversation' }));
    await c.until((m) => m.type === 'started');
    c.ws.send(Buffer.from(new Int16Array(1600).buffer));
    const d = await c.until((m) => m.type === 'decision');
    expect(got).toEqual([1600]);
    expect((d.decision as { addressedToHepta: boolean }).addressedToHepta).toBe(true);
    c.ws.close();
  });

  it('tells the page plainly when live audio has no recognizer key', async () => {
    const s = await startStudio({ env: {}, publicDir: 'apps/studio/public', clipsDir: 'bench/clips', port: 0 });
    close = s.close;
    const c = client(s.port);
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'start', input: 'mic' }));
    const e = await c.until((m) => m.type === 'error');
    expect(String(e.message)).toMatch(/DEEPGRAM_API_KEY or ASSEMBLYAI_API_KEY/);
    c.ws.close();
  });
});

describe('the page-side downsampler', () => {
  it('turns 48 kHz float into 16 kHz PCM without losing its place between frames', () => {
    const d = new Downsampler(48000);
    let n = 0;
    for (let i = 0; i < 10; i++) n += d.push(new Float32Array(1000).fill(0.5)).length;
    expect(Math.abs(n - 10000 / 3)).toBeLessThanOrEqual(1);
    expect(new Downsampler(48000).push(new Float32Array(300).fill(0.5))[0]).toBe(Math.round(0.5 * 32767));
  });
});
