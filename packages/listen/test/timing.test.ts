import { describe, expect, it } from 'vitest';
import { Listener } from '../src/engine.js';
import { HeuristicDetector } from '../src/heuristic.js';
import { SonnetResponder, writeResponse, type Responder, type ResponseRequest } from '../src/respond.js';
import type { ClaudeLike, FinalMessage } from '../src/claude.js';
import type { JevDecision, Mode, SttChunk } from '../src/types.js';

/** Speech arriving as a streaming recognizer delivers it: a partial every two words, a final at the end. */
function speaker(l: Listener) {
  let t = 0;
  let u = 0;
  const said: JevDecision[] = [];
  const say = async (label: string, text: string, gapMs = 900) => {
    const id = `u${++u}`;
    const toks = text.split(/\s+/);
    const start = t + gapMs;
    const words = toks.map((w, i) => ({ text: w, startMs: start + i * 330, endMs: start + i * 330 + 280, speaker: label }));
    const out: JevDecision[] = [];
    for (let n = 2; n <= toks.length; n += 2) {
      const ws = words.slice(0, n);
      const c: SttChunk = { utteranceId: id, text: ws.map((w) => w.text).join(' '), final: false, words: ws, startMs: start, endMs: ws[ws.length - 1]!.endMs, heardToMs: ws[ws.length - 1]!.endMs + 60 };
      const fired = await l.tick(c.startMs);
      if (fired) out.push(fired);
      out.push(await l.hear(c));
    }
    const fin: SttChunk = { utteranceId: id, text, final: true, words, startMs: start, endMs: words[words.length - 1]!.endMs, heardToMs: words[words.length - 1]!.endMs + 320 };
    const fired = await l.tick(fin.startMs);
    if (fired) out.push(fired);
    out.push(await l.hear(fin));
    t = fin.endMs;
    said.push(...out);
    return out;
  };
  return { say, said, quiet: async (ms = 2000) => { const f = await l.tick(t + ms); if (f) said.push(f); return f; } };
}

function make(mode: Mode, extra: Partial<ConstructorParameters<typeof Listener>[0]> = {}) {
  const l = new Listener({ mode, detector: new HeuristicDetector(), ...extra });
  return { l, ...speaker(l) };
}

const responds = (ds: JevDecision[]) => ds.filter((d) => d.respondState === 'respond');

describe('conversation: when Hepta takes the floor', () => {
  it('cuts in on a changed figure at the next clause boundary, never mid-clause', async () => {
    const { l, say } = make('conversation');
    l.name('S1', 'Me', 'user');
    await say('0', 'My savings goal is 300 a month, which feels doable.');
    const ds = await say('0', 'So the savings goal is going to be 500 a month and I am fine with that.');
    const r = responds(ds);
    expect(r).toHaveLength(1);
    expect(r[0]!.boundary).toBe(true);
    expect(r[0]!.text).toMatch(/and$/);
    expect(ds.filter((d) => d.respondState === 'respond' && !d.boundary)).toHaveLength(0);
  });

  it('answers a question when the turn ends, not when the sentence does', async () => {
    const { l, say, quiet } = make('conversation');
    l.name('S1', 'Me', 'user');
    const first = await say('0', 'What about the trip?');
    expect(responds(first)).toHaveLength(0);
    const second = await say('0', 'Can I afford it?', 400); // went on after a short pause
    expect(responds(second)).toHaveLength(0);
    const fired = await quiet();
    expect(fired).toMatchObject({ respondState: 'respond', trigger: 'turn-end', text: 'Can I afford it?' });
  });
});

describe('voice activity', () => {
  it('holds an answer while someone is speaking whose words have not arrived yet', async () => {
    const { l, say } = make('conversation');
    l.name('S1', 'Me', 'user');
    const q = await say('0', 'What about the trip?');
    const end = q[q.length - 1]!.atMs;
    l.speechStarted(end + 300); // they went on, the recognizer has not delivered a word yet
    expect(await l.tick(end + 2000)).toBeNull();
    const more = await say('0', 'Can I afford it?', 300);
    expect(responds(more)).toHaveLength(0);
    expect(await l.tick(more[more.length - 1]!.atMs + 2000)).toMatchObject({ respondState: 'respond', text: 'Can I afford it?' });
  });
});

describe('panel: points wait for the cue', () => {
  it('holds what it noticed as READY, says nothing until cued, then says it all once', async () => {
    const { l, say, said, quiet } = make('panel');
    l.name('S1', 'Moderator', 'moderator'); l.name('S2', 'Minister', 'panelist'); l.name('S3', 'Shadow minister', 'panelist');
    await say('0', 'Tonight we start with housing.');
    await say('1', 'Our plan builds 40,000 homes by 2028, fully funded.');
    await say('2', 'How is it funded? You have not said.');
    const attack = await say('1', 'What I can tell you is that crime is up under your government.');
    expect(attack.some((d) => d.respondState === 'ready')).toBe(true);
    expect(responds(said)).toHaveLength(0);
    await say('0', 'Hepta, anything to flag so far?');
    const fired = await quiet();
    expect(fired?.respondState).toBe('respond');
    await new Promise((r) => setTimeout(r, 0));
    expect(l.responses).toHaveLength(1);
    expect(l.responses[0]!.text).toMatch(/S2 answered with the shadow minister’s record/);
    expect(l.timing.waiting).toHaveLength(0);
  });
});

describe('debater: push once, concede on reasons', () => {
  const stance = { topic: 'net zero cost', keys: ['net zero', 'cost', 'gdp'], position: 'Net zero is affordable: under 1% of GDP a year.', confidence: 0.8, evidence: ['estimate under 1% of GDP'] };
  const evidence = [{ id: 'e1', subject: 'net zero cost', keys: ['net zero', 'cost', 'gdp'], value: 1, unit: '%', text: 'Net cost under 1% of GDP a year', source: 'Committee, 2025' }];

  it('cuts in once on evidence against its stance, and gives up after two real reasons', async () => {
    const { l, say, said } = make('debater', { stance, evidence });
    l.name('S1', 'Host', 'moderator'); l.name('S2', 'Opponent', 'panelist');
    await say('0', 'Opening against.');
    const first = await say('1', 'The real cost is 5 percent of GDP a year, and that is before the bills.');
    expect(responds(first)).toHaveLength(1);
    expect(responds(first)[0]!.boundary).toBe(true);
    const again = await say('1', 'I repeat, the cost is 5 percent of GDP a year, and that is that.');
    expect(responds(again)).toHaveLength(0); // the same disagreement: it has had its say
    expect(l.timing.stance()).toMatchObject({ conceded: false, confidence: expect.closeTo(0.45, 5) });
    await say('1', 'Because the figures leave out the grid upgrades.');
    expect(l.timing.stance()).toMatchObject({ conceded: true });
    expect(l.timing.stanceLog.map((x) => x.reply)).toEqual(['holding', 'conceded']);
    await say('0', 'Hepta, a final word?');
    await new Promise((r) => setTimeout(r, 0));
    const fired = await l.tick(1e9);
    expect(fired?.respondState).toBe('respond');
    await new Promise((r) => setTimeout(r, 0));
    expect(l.responses[l.responses.length - 1]!.text).toMatch(/Fair point|accept/);
    void said;
  });
});

describe('the floor while Hepta speaks', () => {
  it('keeps going through a nod and stops for a word that takes the turn', async () => {
    const { l, say } = make('conversation');
    const events: string[] = [];
    l.on((e) => { if (e.type === 'floor') events.push(e.floor); });
    l.setSpeaking(true);
    await say('0', 'Yeah.');
    expect(l.timing.speaking).toBe(true);
    await say('0', 'Wait, that is not what I said.');
    expect(l.timing.speaking).toBe(false);
    expect(events).toContain('keep');
    expect(events[events.length - 1]).toBe('yield');
  });
});

describe('half a sentence', () => {
  it('shows a card early when one reading leads, and confirms it on the whole sentence', async () => {
    const { l, say } = make('panel');
    l.name('S1', 'Moderator', 'moderator'); l.name('S2', 'Minister', 'panelist'); l.name('S3', 'Shadow minister', 'panelist');
    await say('0', 'Tonight we start with housing.');
    await say('1', 'Our plan builds 40,000 homes by 2028, fully funded.');
    await say('2', 'How is it funded?');
    const states: string[] = [];
    l.on((e) => { if (e.type === 'insight' && e.insight.kind === 'diversion') states.push(e.insight.status); });
    await say('1', 'Record investment, from a man who has never built a shed, let alone a house.');
    expect(states[0]).toBe('provisional');
    expect(states[states.length - 1]).toBe('confirmed');
    const card = l.insights.find((i) => i.kind === 'diversion')!;
    expect(card.shownAtMs).toBeLessThan(l.decisions.find((d) => d.final && d.utteranceId === card.utteranceId)!.atMs);
  });

  it('takes a card back when the end of the sentence turns it into an answer', async () => {
    const { l, say } = make('panel');
    l.name('S1', 'Moderator', 'moderator'); l.name('S2', 'Minister', 'panelist');
    await say('0', 'Minister, how will you pay for free school meals for every child?');
    const states: string[] = [];
    l.on((e) => { if (e.type === 'insight') states.push(`${e.insight.kind}:${e.insight.status}`); });
    await say('1', 'What I can tell you is that it will be paid for by closing the non-dom loophole.');
    const confirmedDiversions = states.filter((s) => s === 'diversion:confirmed');
    expect(confirmedDiversions).toHaveLength(0);
    if (states.includes('diversion:provisional')) expect(states).toContain('diversion:retracted');
  });
});

describe('writing the response', () => {
  const req: ResponseRequest = { mode: 'panel', reason: 'cue', points: [{ text: 'S2 moved from housing to crime. S3’s question is still open.', quotes: [] }],
    recent: [], open: [], claims: [], evidence: [], speakers: [] };

  it('goes round the pyramid: read, write, record', async () => {
    const out = await writeResponse(req, { name: 'fake', write: async (_r, findings) => `I see ${findings.length} finding(s).` });
    expect(out.text).toBe('I see 1 finding(s).');
    expect(out.ledger.map((e) => e.kind)).toEqual(['goal', 'findings', 'plan', 'answer']);
  });

  it('falls back to the template when the writer fails, and says so', async () => {
    const broken: Responder = { name: 'sonnet', write: async () => { throw new Error('overloaded'); } };
    const out = await writeResponse(req, broken);
    expect(out.text).toBe('One thing. S2 moved from housing to crime. S3’s question is still open.');
    expect(out.responder).toBe('template (after sonnet failed)');
    expect(out.error).toBe('overloaded');
  });

  it('asks Sonnet 5.5 with thinking off, low effort, a cached system prompt and the server-side fallback', async () => {
    const calls: Record<string, unknown>[] = [];
    const msg: FinalMessage = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'S2 at 00:21 moved to crime.' }] };
    const stream = () => Object.assign({ async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'S2 at 00:21 moved to crime.' } }; } }, { finalMessage: async () => msg });
    const client: ClaudeLike = { messages: { stream: (p) => { calls.push(p); return stream(); } }, beta: { messages: { stream: (p) => { calls.push(p); return stream(); } } } };
    const deltas: string[] = [];
    const text = await new SonnetResponder({ client }).write(req, [], (d) => deltas.push(d));
    expect(text).toBe('S2 at 00:21 moved to crime.');
    expect(deltas).toEqual(['S2 at 00:21 moved to crime.']);
    const p = calls[0]!;
    expect(p).toMatchObject({ model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' }, output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect((p.system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(p).not.toHaveProperty('temperature');
  });
});
