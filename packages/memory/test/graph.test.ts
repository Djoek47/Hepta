import { describe, expect, it } from 'vitest';
import { EphemeralStore, MAIN, MemoryError, openMemory } from '../src/index.js';

function mem() {
  let t = 1000;
  const store = new EphemeralStore();
  return { store, ...openMemory(store, () => (t += 1000)) };
}

describe('one memory, one pen', () => {
  it('hands the reader nothing that writes', () => {
    const { reader } = mem();
    const names = Object.keys(reader);
    expect(names.filter((n) => /commit|write|merge|drop|branch$|put|set|add/i.test(n))).toEqual([]);
  });

  it("records a fact with the words it came from, and refuses one without them", () => {
    const { reader, writer } = mem();
    writer.commit(MAIN, 'congregator', 'heard', [{ kind: 'fact', key: 'grocery budget', value: '400', said: 'my grocery budget is 400' }]);
    expect(reader.view().facts['grocery budget']).toMatchObject({ value: '400', said: 'my grocery budget is 400' });
    expect(() => writer.commit(MAIN, 'congregator', 'x', [{ kind: 'fact', key: 'k', value: 'v', said: '' }])).toThrow(/words it came from/);
  });

  it('never lets the aggregator or orchestrator write a fact', () => {
    const { writer } = mem();
    for (const by of ['aggregator', 'orchestrator', 'conductor'] as const) {
      expect(() => writer.commit(MAIN, by, 'x', [{ kind: 'fact', key: 'k', value: 'v', said: 'I said it' }])).toThrow(/not the/);
    }
  });

  it('keeps a finding a finding', () => {
    const { reader, writer } = mem();
    writer.commit(MAIN, 'aggregator', 'bank', [{ kind: 'finding', source: 'bank', claim: 'groceries averaged $412' }]);
    expect(reader.view().facts).toEqual({});
    expect(reader.view().findings[0]!.claim).toContain('$412');
  });
});

describe('lines of thought as branches', () => {
  it('lets a branch hold thoughts and findings', () => {
    const { reader, writer } = mem();
    writer.branch('what-if-650');
    writer.commit('what-if-650', 'orchestrator', 'explore', [{ kind: 'thought', topic: 'budget', text: 'at 650 the trip slips a month' }]);
    expect(reader.view('what-if-650').thoughts).toHaveLength(1);
    expect(reader.view(MAIN).thoughts).toHaveLength(0);
  });

  it('refuses anything real on a branch: nothing real can be hypothetical', () => {
    const { writer } = mem();
    writer.branch('hunch');
    for (const r of [
      { kind: 'fact', key: 'k', value: 'v', said: 'x' },
      { kind: 'decision', act: 'pay', id: '1', summary: 's' },
      { kind: 'delegation', tool: 't', radius: 'self' },
      { kind: 'order', id: 'o', text: 't', active: true },
    ] as const) {
      expect(() => writer.commit('hunch', 'congregator', 'x', [r])).toThrow(MemoryError);
    }
  });

  it('merges a line of thought into main, and dropping one loses only it', () => {
    const { reader, writer } = mem();
    writer.commit(MAIN, 'congregator', 'heard', [{ kind: 'fact', key: 'rent', value: '1450', said: 'rent is 1450' }]);
    writer.branch('a'); writer.branch('b');
    writer.commit('a', 'orchestrator', 'x', [{ kind: 'thought', topic: 'rent', text: 'rent is 40% of income' }]);
    writer.commit('b', 'orchestrator', 'y', [{ kind: 'thought', topic: 'rent', text: 'a cheaper place saves 300' }]);
    writer.merge('a', 'congregator', 'kept');
    writer.drop('b');
    const v = reader.view();
    expect(v.thoughts.map((t) => t.text)).toEqual(['rent is 40% of income']);
    expect(v.facts.rent!.value).toBe('1450');
    expect(reader.branches()).toEqual(['main', 'a']);
  });

  it('refuses to drop main', () => {
    expect(() => mem().writer.drop(MAIN)).toThrow(/cannot be dropped/);
  });
});

describe('what everyone reads', () => {
  it('folds decisions, undos, delegations and orders', () => {
    const { reader, writer } = mem();
    writer.commit(MAIN, 'congregator', 'c', [{ kind: 'decision', act: 'add_task', id: 't1', summary: 'buy milk' }]);
    writer.commit(MAIN, 'congregator', 'c', [{ kind: 'undone', act: 'add_task', id: 't1' }]);
    writer.commit(MAIN, 'congregator', 'c', [
      { kind: 'decision', act: 'set_delegation', id: 'tasks/add_task', summary: 'let it go ahead' },
      { kind: 'delegation', tool: 'tasks/add_task', radius: 'self' },
    ]);
    writer.commit(MAIN, 'congregator', 'c', [
      { kind: 'decision', act: 'set_standing_order', id: 'morning', summary: 'every morning' },
      { kind: 'order', id: 'morning', text: 'every morning, list what is due', active: true },
    ]);
    const v = reader.view();
    expect(v.decisions[0]!.undone).toBe(true);
    expect(v.delegations).toEqual({ 'tasks/add_task': 'self' });
    expect(v.orders.morning!.active).toBe(true);
  });

  it('takes back what an undone decision wrote: the delegation it granted, the order it created', () => {
    // Found by independent review: undo reverted the live radius, but memory
    // still said "self", and a restart silently re-applied it.
    const { reader, writer } = mem();
    writer.commit(MAIN, 'congregator', 'before', [
      { kind: 'decision', act: 'set_delegation', id: 'tasks/add_task', summary: 'ask first' },
      { kind: 'delegation', tool: 'tasks/add_task', radius: 'other-person' },
    ]);
    writer.commit(MAIN, 'congregator', 'granted', [
      { kind: 'decision', act: 'set_delegation', id: 'tasks/add_task#2', summary: 'go ahead' },
      { kind: 'delegation', tool: 'tasks/add_task', radius: 'self' },
      { kind: 'decision', act: 'set_standing_order', id: 'o1', summary: 'hourly' },
      { kind: 'order', id: 'o1', text: 'every hour', active: true },
    ]);
    expect(reader.view().delegations['tasks/add_task']).toBe('self');
    writer.commit(MAIN, 'congregator', 'undo', [{ kind: 'undone', act: 'set_delegation', id: 'tasks/add_task#2' }]);
    const v = reader.view();
    expect(v.delegations['tasks/add_task']).toBe('other-person'); // back to what it was, not gone, not "self"
    expect(v.orders.o1!.active).toBe(false);                     // written in the same undone commit
  });

  it('finds things by their words', () => {
    const { reader, writer } = mem();
    writer.commit(MAIN, 'congregator', 'c', [{ kind: 'fact', key: 'grocery budget', value: '400', said: 'my grocery budget is 400' }]);
    writer.commit(MAIN, 'aggregator', 'c', [{ kind: 'finding', source: 'bank', claim: 'groceries averaged $412' }]);
    expect(reader.search('grocery budget')[0]!.kind).toBe('fact');
    expect(reader.search('weather')).toEqual([]);
  });

  it('survives a restart, and a corrupt file does not take the app down', () => {
    const a = mem();
    a.writer.commit(MAIN, 'congregator', 'c', [{ kind: 'fact', key: 'k', value: 'v', said: 'said' }]);
    a.writer.branch('line');
    const b = openMemory(a.store);
    expect(b.reader.view().facts.k!.value).toBe('v');
    expect(b.reader.branches()).toContain('line');

    const bad = new EphemeralStore(); bad.save('{not json');
    expect(openMemory(bad).reader.view().facts).toEqual({});
  });
});
