import { describe, expect, it } from 'vitest';
import { remainder } from '../src/index.js';

describe('the free-text guess', () => {
  const r = remainder(['add', 'remind me to'], () => new Set(['maya', 'sam', 'home', 'work']));
  const v = (t: string) => r(t)[0]?.value;
  it('leaves times, amounts and people to their own slots', () => {
    expect(v('add the dishes for Maya tomorrow')).toBe('dishes');
    expect(v('remind me to pay rent on friday')).toBe('pay rent');
    expect(v('add buy milk to the home list')).toBe('buy milk');
    expect(v('add call mum at 9')).toBe('call mum');
  });
  it('keeps what is part of the thing itself', () => {
    expect(v('add call home')).toBe('call home');
    expect(v('add buy 2 apples')).toBe('buy 2 apples');
  });
  it('is always a guess', () => {
    expect(r('add something')[0]).toMatchObject({ calibrated: false, score: 0.6 });
  });
});
