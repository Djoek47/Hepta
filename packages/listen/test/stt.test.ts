import { describe, expect, it } from 'vitest';
import { UtteranceAssembler } from '../src/stt/assemble.js';
import { deepgram, deepgramUrl } from '../src/stt/deepgram.js';
import { assemblyai, assemblyAiUrl, turnChunk } from '../src/stt/assemblyai.js';
import { scriptedProvider } from '../src/stt/scripted.js';
import type { SocketLike } from '../src/stt/provider.js';
import type { SttChunk, Word } from '../src/types.js';
import type { Clip } from '../src/clip.js';

const w = (text: string, s: number, speaker: string | null = '0'): Word => ({ text, startMs: s, endMs: s + 200, speaker });

/** A socket that records what is sent and lets the test play the server's side. */
function fakeSocket() {
  const sent: (string | Uint8Array)[] = [];
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  let url = '';
  let headers: Record<string, string> = {};
  const sock: SocketLike = {
    send: (d) => { sent.push(d); },
    close: () => { for (const h of handlers.close ?? []) h(); },
    on: ((ev: string, fn: (...a: unknown[]) => void) => { (handlers[ev] ??= []).push(fn); }) as SocketLike['on'],
  };
  return {
    sent, sock,
    factory: (u: string, h: Record<string, string>) => { url = u; headers = h; return sock; },
    get url() { return url; }, get headers() { return headers; },
    open: () => { for (const h of handlers.open ?? []) h(); },
    message: (m: unknown) => { for (const h of handlers.message ?? []) h(JSON.stringify(m)); },
    close: () => { for (const h of handlers.close ?? []) h(); },
  };
}

describe('assembling utterances from segments', () => {
  it('keeps finalized words, rides interim words on top, and ends at the endpoint', () => {
    const out: SttChunk[] = [];
    const a = new UtteranceAssembler('t', (c) => out.push(c));
    a.segment([w('How', 0), w('is', 200)], false, false, 450);
    a.segment([w('How', 0), w('is', 200), w('it', 400)], true, false, 650);
    a.segment([w('funded?', 600)], false, false, 850);
    a.segment([w('funded?', 600)], true, true, 1200);
    expect(out.map((c) => [c.text, c.final])).toEqual([['How is', false], ['How is it', false], ['How is it funded?', false], ['How is it funded?', true]]);
    expect(new Set(out.map((c) => c.utteranceId)).size).toBe(1);
  });

  it('splits where a new speaker holds the floor for three words, not for one', () => {
    const out: SttChunk[] = [];
    const a = new UtteranceAssembler('t', (c) => out.push(c));
    a.segment(['We', 'would', 'cut', 'it', 'by'].map((x, i) => w(x, i * 200, '0')), true, false, 1000);
    a.segment([w('half', 1000, '1')], true, false, 1200); // one wavering word: no split
    a.segment(['That', 'is', 'not', 'true'].map((x, i) => w(x, 1400 + i * 200, '1')), true, false, 2200);
    const finals = out.filter((c) => c.final);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('We would cut it by');
    expect(out[out.length - 1]!.text).toBe('half That is not true');
    expect(out[out.length - 1]!.utteranceId).not.toBe(finals[0]!.utteranceId);
  });
});

describe('Deepgram live', () => {
  it('asks for diarization, interim results and an endpoint, with the key in a header', () => {
    const url = new URL(deepgramUrl({ apiKey: 'k' }, 16000));
    expect(url.host).toBe('api.deepgram.com');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ diarize: 'true', interim_results: 'true', encoding: 'linear16', sample_rate: '16000', model: 'nova-3', punctuate: 'true' });
  });

  it('turns Results messages into chunks with a speaker per word, and closes the stream at the end', async () => {
    const f = fakeSocket();
    const s = await deepgram({ apiKey: 'secret', socket: f.factory }).open({ sampleRate: 16000 });
    const chunks: SttChunk[] = [];
    s.on((e) => { if (e.type === 'chunk') chunks.push(e.chunk); });
    expect(f.headers).toEqual({ Authorization: 'Token secret' });
    s.send(new Int16Array([1, 2, 3])); // before open: held, then sent
    f.open();
    expect(f.sent[0]).toBeInstanceOf(Uint8Array);
    const word = (word: string, start: number, speaker: number) => ({ word: word.toLowerCase().replace(/[^a-z0-9]/g, ''), punctuated_word: word, start, end: start + 0.2, confidence: 0.9, speaker });
    f.message({ type: 'Results', is_final: false, speech_final: false, start: 0, duration: 0.6, channel: { alternatives: [{ transcript: 'how is', words: [word('How', 0, 1), word('is', 0.25, 1)] }] } });
    f.message({ type: 'Results', is_final: true, speech_final: true, start: 0, duration: 1.2, channel: { alternatives: [{ transcript: 'how is it funded', words: [word('How', 0, 1), word('is', 0.25, 1), word('it', 0.5, 1), word('funded?', 0.75, 1)] }] } });
    expect(chunks.map((c) => [c.text, c.final])).toEqual([['How is', false], ['How is it funded?', true]]);
    expect(chunks[1]!.words.every((x) => x.speaker === '1')).toBe(true);
    expect(chunks[1]!.words[3]).toMatchObject({ startMs: 750, endMs: 950 });
    const fin = s.finish();
    expect(f.sent[f.sent.length - 1]).toBe(JSON.stringify({ type: 'CloseStream' }));
    f.close();
    await fin;
  });

  it('ends an utterance on UtteranceEnd when no endpoint came', async () => {
    const f = fakeSocket();
    const s = await deepgram({ apiKey: 'k', socket: f.factory }).open({ sampleRate: 16000 });
    const chunks: SttChunk[] = [];
    s.on((e) => { if (e.type === 'chunk') chunks.push(e.chunk); });
    f.open();
    f.message({ type: 'Results', is_final: true, speech_final: false, start: 0, duration: 1, channel: { alternatives: [{ words: [{ word: 'yes', start: 0.1, end: 0.3, speaker: 0 }] }] } });
    f.message({ type: 'UtteranceEnd', last_word_end: 0.3 });
    expect(chunks.map((c) => c.final)).toEqual([false, true]);
    s.close();
  });
});

describe('AssemblyAI Universal-Streaming', () => {
  it('asks for speaker labels and formatted turns', () => {
    const q = new URL(assemblyAiUrl({ apiKey: 'k' }, 16000)).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ speaker_labels: 'true', format_turns: 'true', encoding: 'pcm_s16le', sample_rate: '16000' });
  });

  it('gives the turn speaker to every word, takes the formatted copy as final, and leaves UNKNOWN unlabelled', () => {
    const words = [{ text: 'how', start: 0, end: 200, word_is_final: true }, { text: 'is', start: 250, end: 400, word_is_final: true }];
    const partial = turnChunk({ type: 'Turn', turn_order: 3, end_of_turn: false, words, speaker_label: 'B' }, true)!;
    expect(partial).toMatchObject({ utteranceId: 'aai-3', final: false, text: 'how is' });
    expect(partial.words.every((x) => x.speaker === 'B')).toBe(true);
    expect(turnChunk({ type: 'Turn', turn_order: 3, end_of_turn: true, turn_is_formatted: false, words, speaker_label: 'B' }, true)!.final).toBe(false);
    const fin = turnChunk({ type: 'Turn', turn_order: 3, end_of_turn: true, turn_is_formatted: true, transcript: 'How is?', words, speaker_label: 'B' }, true)!;
    expect(fin).toMatchObject({ final: true, text: 'How is?' });
    expect(turnChunk({ type: 'Turn', turn_order: 4, words, speaker_label: 'UNKNOWN' }, true)!.words[0]!.speaker).toBeNull();
    expect(turnChunk({ type: 'Turn', turn_order: 5, words, speaker: 'A' }, true)!.words[0]!.speaker).toBe('A');
  });

  it('sends the key as the Authorization header and terminates at the end', async () => {
    const f = fakeSocket();
    const s = await assemblyai({ apiKey: 'aai-key', socket: f.factory }).open({ sampleRate: 16000 });
    const chunks: SttChunk[] = [];
    s.on((e) => { if (e.type === 'chunk') chunks.push(e.chunk); });
    expect(f.headers).toEqual({ Authorization: 'aai-key' });
    f.open();
    f.message({ type: 'Begin', id: 'x' });
    f.message({ type: 'Turn', turn_order: 0, end_of_turn: true, turn_is_formatted: true, transcript: 'Hello.', words: [{ text: 'Hello.', start: 0, end: 300 }], speaker_label: 'A' });
    expect(chunks).toHaveLength(1);
    const fin = s.finish();
    expect(f.sent[f.sent.length - 1]).toBe(JSON.stringify({ type: 'Terminate' }));
    f.close();
    await fin;
  });
});

describe('a scripted clip as a recognizer', () => {
  it('delivers every simulated chunk, in order, then closes', async () => {
    const clip: Clip = { id: 'c', title: 'c', mode: 'panel', speakers: { A: { name: 'A', role: 'panelist' }, B: { name: 'B', role: 'panelist' } },
      turns: [{ id: 't1', speaker: 'A', text: 'Growth is three percent.' }, { id: 't2', speaker: 'B', text: 'That is not right.' }] };
    const s = await scriptedProvider(clip, { speed: 1000 }).open({ sampleRate: 16000 });
    const got: SttChunk[] = [];
    let closed = false;
    s.on((e) => { if (e.type === 'chunk') got.push(e.chunk); if (e.type === 'close') closed = true; });
    await s.finish();
    expect(closed).toBe(true);
    expect(got.filter((c) => c.final).map((c) => c.text)).toEqual(['Growth is three percent.', 'That is not right.']);
  });
});
