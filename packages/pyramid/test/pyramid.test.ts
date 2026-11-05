import { describe, expect, it } from 'vitest';
import { FakeClock, type Ctx, type Option } from '@intermenu/aiuic-core';
import { createApp, defineAct } from './app.js';
import { resolveQuantity } from '@intermenu/aiuic-resolve';
import * as Pyr from '../src/index.js';
import { Aggregator, Pyramid, tableSource, type Orchestrator, type Plan } from '../src/index.js';

const T0 = 1_700_000_000_000;
declare const setTimeout: (fn: () => void, ms: number) => unknown;
const tick = () => new Promise<void>((r) => setTimeout(() => r(), 0));
const attention = { foreground: true, unlocked: true, proximityClear: true, listening: true };

const CATS: Option[] = [{ value: 'groceries', label: 'Groceries' }, { value: 'rent', label: 'Rent' }];

function build(orchestrator: Orchestrator, opts: { maxDepth?: number } = {}) {
  const clock = new FakeClock(T0);
  const written: unknown[] = [];
  const ctxFn = () => ({ actor: { id: 'me', basePauseMs: 850 }, attention, reachLimit: 1, undoWindowMs: 5000 });
  const app = createApp({
    clock, ctx: ctxFn,
    acts: [defineAct({
      name: 'set_budget', domain: 'allowance', phrases: ['budget'],
      slots: {
        category: { primitive: 'chip', options: () => CATS, required: true, order: 1 },
        amount: { primitive: 'quantity', resolve: resolveQuantity, required: true, order: 2 },
      },
      radius: 'self',
      commit: (f) => { written.push(f); return { id: 'b' + written.length }; },
      undo: () => { written.pop(); },
    })],
  });
  const aggregator = new Aggregator([
    tableSource('bank', [
      { claim: 'groceries averaged $412 over three months', value: 412, words: ['groceries', 'food'] },
      { claim: 'rent is $1,450', value: 1450, words: ['rent', 'housing'] },
    ]),
  ]);
  const pyramid = new Pyramid({
    app, aggregator, orchestrator,
    ctx: () => ({ ...ctxFn(), now: new Date(clock.now()) }) as Ctx,
    now: () => clock.now(),
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
  });
  return { app, pyramid, clock, written, async advance(ms: number) { clock.advance(ms); await tick(); } };
}

describe('authority, not votes', () => {
  it('gives the orchestrator a ledger it cannot write to', async () => {
    let seen: unknown = null;
    const h = build((input) => { seen = input.ledger; return { kind: 'answer', answer: 'ok' }; });
    await h.pyramid.pursue('what do I spend on groceries');
    expect(Object.isFrozen((seen as unknown[])[0])).toBe(true);
    expect(() => (seen as { kind: string }[])[0]!.kind = 'committed').toThrow();
  });

  it('exposes no named way to write a decision into the record', () => {
    const h = build(() => ({ kind: 'answer', answer: 'x' }));
    const c = h.pyramid.congregator as unknown as Record<string, unknown>;
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(c));
    expect(proto.filter((n) => /write|record|push|add|set/i.test(n))).toEqual([]);
    // and nothing outside the module can name the symbol it does use
    expect(Object.keys(Pyr).some((k) => /write/i.test(k))).toBe(false);
  });

  it('records a decision only when the contract reports one', async () => {
    const h = build(() => ({
      kind: 'propose', act: 'set_budget', why: 'three months of data',
      fill: { category: 'groceries', amount: { n: 420, label: '$420' } },
    }));
    const out = await h.pyramid.pursue('set my grocery budget');
    expect(out.kind).toBe('proposed');
    expect(h.pyramid.congregator.decisions()).toEqual([]);
    expect(h.written).toEqual([]);
  });
});

describe('the conductor', () => {
  it('lets a proposal nobody spoke into wait for a yes, however long the silence', async () => {
    const h = build(() => ({
      kind: 'propose', act: 'set_budget', why: 'x',
      fill: { category: 'groceries', amount: { n: 420, label: '$420' } },
    }));
    const out = await h.pyramid.pursue('set my grocery budget');
    expect(out).toMatchObject({ kind: 'proposed', status: 'explicit' });
    await h.advance(60_000);
    expect(h.written).toEqual([]);
  });

  it('makes it true when the conductor says yes, and the record follows', async () => {
    const h = build(() => ({
      kind: 'propose', act: 'set_budget', why: 'x',
      fill: { category: 'groceries', amount: { n: 420, label: '$420' } },
    }));
    await h.pyramid.pursue('set my grocery budget');
    await h.app.act!.assent();
    await tick();
    expect(h.written.length).toBe(1);
    expect(h.pyramid.congregator.decisions().map((e) => e.kind)).toEqual(['committed']);
  });

  it('refuses a proposal for an act the app does not have', async () => {
    const h = build(() => ({ kind: 'propose', act: 'wire_money', why: 'x', fill: {} }));
    const out = await h.pyramid.pursue('send it all');
    expect(out).toMatchObject({ kind: 'stopped' });
    expect(h.app.act).toBeNull();
  });

  it('drops slots the orchestrator invented', async () => {
    const h = build(() => ({
      kind: 'propose', act: 'set_budget', why: 'x',
      fill: { category: 'groceries', amount: { n: 1, label: '$1' }, radius: 'self', commit: 'now' },
    }));
    await h.pyramid.pursue('budget');
    expect(Object.keys(h.app.act!.filled).sort()).toEqual(['amount', 'category']);
  });
});

describe('the loop', () => {
  it('aggregates before it orchestrates, and the orchestrator sees what was found', async () => {
    let findings: readonly Pyr.Finding[] = [];
    const h = build((i) => { findings = i.findings; return { kind: 'answer', answer: 'x' }; });
    await h.pyramid.pursue('what do I spend on groceries');
    expect(findings[0]!.claim).toContain('$412');
  });

  it('looks again with a sharper question, and must decide after the budget', async () => {
    let calls = 0;
    const h = build(() => { calls++; return { kind: 'look', query: 'look harder' }; });
    const out = await h.pyramid.pursue('anything');
    expect(out).toMatchObject({ kind: 'stopped' });
    expect(calls).toBe(Pyr.DEFAULT_MAX_LOOKS + 1);
  });

  it('splits a goal, pursues each part one level down, then decides with the parts in hand', async () => {
    const seenParts: string[][] = [];
    const h = build((i): Plan => {
      if (i.goal === 'plan my month') {
        if (!i.parts) return { kind: 'split', goals: ['groceries', 'rent'] };
        seenParts.push(i.parts.map((p) => p.goal));
        return { kind: 'answer', answer: 'about $1,862' };
      }
      return { kind: 'answer', answer: String(i.findings[0]?.value ?? '?') };
    });
    const out = await h.pyramid.pursue('plan my month');
    expect(seenParts).toEqual([['groceries', 'rent']]);
    expect(out.kind).toBe('split');
    if (out.kind === 'split') {
      expect(out.parts.map((p) => p.outcome)).toEqual([
        { kind: 'answered', answer: '412' }, { kind: 'answered', answer: '1450' },
      ]);
      expect(out.then).toEqual({ kind: 'answered', answer: 'about $1,862' });
    }
  });

  it('stops a cycle instead of chasing its own tail', async () => {
    const h = build((i): Plan => i.parts ? { kind: 'answer', answer: 'done' } : { kind: 'split', goals: [i.goal] });
    const out = await h.pyramid.pursue('the same thing');
    expect(out.kind).toBe('split');
    if (out.kind === 'split') expect(out.parts[0]!.outcome).toMatchObject({ kind: 'stopped', reason: expect.stringMatching(/cycle/) });
  });

  it('spends its depth budget and stops', async () => {
    let n = 0;
    const h = build((i): Plan => i.parts ? { kind: 'answer', answer: 'x' } : { kind: 'split', goals: [`deeper ${n++}`] }, { maxDepth: 2 });
    await h.pyramid.pursue('root');
    const stops = h.pyramid.congregator.view().filter((e) => e.kind === 'stopped');
    expect(stops.some((e) => e.kind === 'stopped' && /depth/.test(e.reason))).toBe(true);
  });

  it('keeps going when a source fails, and says which one', async () => {
    const clock = new FakeClock(T0);
    const agg = new Aggregator([
      { name: 'down', local: false, read: () => { throw new Error('timeout'); } },
      tableSource('bank', [{ claim: 'rent is $1,450', words: ['rent'] }]),
    ]);
    const f = await agg.gather('rent', { now: new Date(clock.now()) } as Ctx);
    expect(f.map((x) => x.source)).toEqual(['bank', 'down']);
    expect(f[1]!.claim).toContain('timeout');
    expect(f[1]!.confidence).toBe(0);
  });

  it('records every step, so the work is congregated and not just the result', async () => {
    const h = build(() => ({ kind: 'answer', answer: 'x' }));
    await h.pyramid.pursue('groceries');
    expect(h.pyramid.congregator.view().map((e) => e.kind)).toEqual(['goal', 'findings', 'plan', 'answer']);
  });
});

import { EphemeralStore, openMemory } from '@intermenu/aiuic-memory';

describe('the shared memory', () => {
  it('lets every role read it and only the congregator write it', async () => {
    const mem = openMemory(new EphemeralStore());
    mem.writer.commit('main', 'congregator', 'heard', [{ kind: 'fact', key: 'grocery budget', value: '400', said: 'my grocery budget is 400' }]);
    let seen: string[] = [];
    const clock = new FakeClock(T0);
    const app = createApp({ clock, acts: [], ctx: () => ({ actor: { id: 'me' }, attention, reachLimit: 1 }) });
    const p = new Pyramid({
      app, memory: mem,
      aggregator: new Aggregator([]),
      orchestrator: (i) => { seen = i.findings.map((f) => f.source); expect(i.memory).toBeDefined(); expect('commit' in i.memory!).toBe(false); return { kind: 'answer', answer: 'x' }; },
      ctx: () => ({ now: new Date(clock.now()) }) as Ctx,
      now: () => clock.now(),
    });
    await p.pursue('what is my grocery budget');
    expect(seen).toContain('memory/fact');
    // the loop's work went to memory as thoughts, never as facts
    const v = mem.reader.view();
    expect(Object.keys(v.facts)).toEqual(['grocery budget']);
    expect(v.thoughts.map((t) => t.topic)).toContain('what is my grocery budget');
  });

  it('records a committed decision, and what the act asked it to remember', async () => {
    const mem = openMemory(new EphemeralStore());
    const clock = new FakeClock(T0);
    const app = createApp({
      clock, speculate: false,
      ctx: () => ({ actor: { id: 'me', basePauseMs: 850 }, attention, reachLimit: 1, undoWindowMs: 5000 }),
      acts: [defineAct({
        name: 'set_order', phrases: ['every morning'],
        slots: { what: { primitive: 'chip', options: () => [{ value: 'due', label: 'what is due' }], required: true, order: 1 } },
        radius: 'self', undo: () => {},
        commit: () => ({ id: 'o1', memory: [{ kind: 'order', id: 'o1', text: 'every morning, what is due', active: true }] }),
      })],
    });
    new Pyramid({ app, memory: mem, aggregator: new Aggregator([]), orchestrator: () => ({ kind: 'answer', answer: '' }),
      ctx: () => ({ now: new Date(clock.now()) }) as Ctx, now: () => clock.now() });
    app.hear('every morning what is due');
    clock.advance(1000); await tick(); await tick();
    const v = mem.reader.view();
    expect(v.decisions.map((d) => d.act)).toEqual(['set_order']);
    expect(v.orders.o1!.active).toBe(true);
  });
});

describe('review 2: what the card shows is what commit() receives', () => {
  it('admits a proposed value only through the slot\'s own options or resolver', async () => {
    const h = build(() => ({
      kind: 'propose', act: 'set_budget', why: 'x',
      fill: { category: { value: 'savings', label: 'Groceries' }, amount: { n: 5000, label: '$50' } },
    }));
    await h.pyramid.pursue('set my grocery budget');
    const slots = h.app.view()!.slots;
    // A category the host never offered is left empty for the person.
    expect(slots.find((s) => s.name === 'category')!.value).toBeUndefined();
    // An amount is read from its words, so the card and the commit agree: $50, not 5000.
    expect((slots.find((s) => s.name === 'amount')!.value as { n: number }).n).toBe(50);
  });
});
