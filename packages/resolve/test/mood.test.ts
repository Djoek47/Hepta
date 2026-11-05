import { describe, expect, it } from 'vitest';
import { mood } from '../src/mood.js';

describe('is this sentence asking for something', () => {
  it('hears requests, including polite questions and wants', () => {
    for (const s of ['do the laundry', 'dishes for Maya', 'Sam should help out', 'Sam can do the washing up',
      'can you pay Maya back', 'I need Maya to do the dishes', 'la vaisselle pour Maya', 'peux-tu payer Sam',
      'pay Maya twenty, sorry, thirty dollars', 'uh the the dishes for Maya'])
      expect([s, mood(s)]).toEqual([s, 'request']);
  });
  it('hears questions', () => {
    for (const s of ['did Sam already take the bins out', 'what is the weather', 'do you know where Maya is',
      'is the laundry done?', 'est-ce que Sam a fait la vaisselle', 'quel temps fait-il'])
      expect([s, mood(s)]).toEqual([s, 'question']);
  });
  it('hears statements', () => {
    for (const s of ['I love doing the dishes', 'twenty dollars is a lot', 'Maya is at school', "c'est trop cher", "it's Sam's turn"])
      expect([s, mood(s)]).toEqual([s, 'statement']);
  });
});

describe('openers that look like requests (second review)', () => {
  it('hears a remark after "can you" and "I need to"', () => {
    expect(mood('can you believe Sam did the dishes')).toBe('statement');
    expect(mood('I need to tell you Maya did the laundry')).toBe('statement');
    expect(mood('can you do the dishes')).toBe('request');
    expect(mood('I need Maya to do the dishes')).toBe('request');
  });
});

describe('the copula has to be the sentence\'s own verb', () => {
  it('does not call a standing order a statement because a clause contains "is"', () => {
    expect(mood('every morning what is due')).toBe('request');
    expect(mood('remind me what is left')).toBe('request');
    // Still statements: the copula is the main verb.
    expect(mood('twenty dollars is a lot')).toBe('statement');
    expect(mood('Maya is at school')).toBe('statement');
  });
});
