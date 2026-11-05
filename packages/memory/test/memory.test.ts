import { describe, expect, it } from 'vitest';
import { createAIUIC, FakeClock } from '@intermenu/aiuic-core';
import { EphemeralStore, Memory, memoryActs, type Store } from '../src/index.js';

declare const setTimeout: (fn: () => void, ms: number) => unknown;
const tick = () => new Promise<void>((r) => setTimeout(() => r(), 0));

function ui(mem: Memory) {
  const clock = new FakeClock(1_700_000_000_000);
  const u = createAIUIC({
    clock,
    ctx: () => ({
      actor: { id: 'me', basePauseMs: 850 },
      attention: { foreground: true, unlocked: true, proximityClear: true, listening: true },
      reachLimit: 1, undoWindowMs: 5000,
    }),
  });
  for (const a of memoryActs(mem)) u.defineAct(a);
  return { u, clock, async advance(ms: number) { clock.advance(ms); await tick(); } };
}

describe('memory', () => {
  it('keeps what it is told and hands back only what is asked for', () => {
    const m = new Memory();
    m.put('income', '3200 after tax');
    m.put('risk', 'if it feels like a diet');
    expect(m.recall(['income'])).toEqual({ income: '3200 after tax' });
    expect(m.recall(['income', 'nothing'])).toEqual({ income: '3200 after tax' });
  });

  it('names the gaps an interview should still cover', () => {
    const m = new Memory();
    m.put('income', '3200');
    expect(m.gaps(['income', 'leak', 'risk'])).toEqual(['leak', 'risk']);
  });

  it('survives a reload through its store', () => {
    const store = new EphemeralStore();
    new Memory(store).put('goal', 'stop being broke');
    expect(new Memory(store).get('goal')).toBe('stop being broke');
  });

  it('shrugs off corrupt storage instead of throwing', () => {
    const bad: Store = { load: () => '{not json', save: () => {} };
    expect(new Memory(bad).size).toBe(0);
  });

  it('shrugs off a store that refuses to save', () => {
    const hostile: Store = { load: () => null, save: () => { throw new Error('quota'); } };
    expect(() => new Memory(hostile)).not.toThrow();
  });

  it('honours keys the host blocked, whatever is said', () => {
    const m = new Memory(new EphemeralStore(), ['ssn']);
    m.put('ssn', '123-45-6789');
    expect(m.has('ssn')).toBe(false);
  });

  it('records every fact as stated, because nothing else can get in', () => {
    const m = new Memory();
    m.put('leak', 'eating out');
    expect(m.all()[0]!.source).toBe('stated');
  });
});

describe('memory as acts', () => {
  it('holds before it writes, and undo puts the old value back', async () => {
    const m = new Memory();
    m.put('income', '2800');
    const h = ui(m);

    const run = h.u.start('remember');
    run.setValue('key', 'income', 'model');
    run.setValue('value', '3200 after tax', 'spoken');
    expect(run.status).toBe('hold');

    await h.advance(900);
    expect(m.get('income')).toBe('3200 after tax');

    await run.undo();
    expect(m.get('income')).toBe('2800');
  });

  it('undo of a brand new fact removes it rather than blanking it', async () => {
    const m = new Memory();
    const h = ui(m);
    const run = h.u.start('remember');
    run.setValue('key', 'risk', 'model');
    run.setValue('value', 'boredom', 'spoken');
    await h.advance(900);
    expect(m.has('risk')).toBe(true);
    await run.undo();
    expect(m.has('risk')).toBe(false);
  });

  it('forgetting is reversible for as long as the window is open', async () => {
    const m = new Memory();
    m.put('leak', 'eating out');
    const h = ui(m);
    const run = h.u.start('forget');
    run.setValue('key', 'leak', 'touched');
    await h.advance(900);
    expect(m.has('leak')).toBe(false);
    await run.undo();
    expect(m.get('leak')).toBe('eating out');
  });
});
