import { describe, expect, it } from 'vitest';

import { FAVORITE_FACTS, loadSeed } from '../src/roster/seed.js';
import type { CardDef } from '../src/roster/types.js';

/** A fully valid card; pass overrides to break one field at a time. */
function card(id: string, overrides: Partial<CardDef> = {}): CardDef {
  return {
    id,
    spriteIndex: 0,
    name: `Name ${id}`,
    role: 'Test Role',
    department: 'Test Department',
    favoriteFact: 'Likes tests.',
    ...overrides,
  };
}

describe('roster seed', () => {
  it('bundled seed has 30 valid cards', () => {
    const cards = loadSeed();
    expect(cards).toHaveLength(30);
    expect(new Set(cards.map((c) => c.id)).size).toBe(30);
    for (const c of cards) expect(c.spriteIndex).toBeGreaterThanOrEqual(0);
  });

  it('bundled seed gives each card its own sprite, 0 through 29', () => {
    const indexes = loadSeed()
      .map((c) => c.spriteIndex)
      .sort((a, b) => a - b);
    expect(indexes).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('bundled facts list has at least 100 lines, every card fact is from it', () => {
    expect(FAVORITE_FACTS.length).toBeGreaterThanOrEqual(100);
    for (const c of loadSeed()) expect(FAVORITE_FACTS).toContain(c.favoriteFact);
  });

  it('every card has a different favorite fact', () => {
    const facts = loadSeed().map((c) => c.favoriteFact);
    expect(new Set(facts).size).toBe(30);
  });

  it('facts list has no duplicates or blank lines', () => {
    expect(new Set(FAVORITE_FACTS).size).toBe(FAVORITE_FACTS.length);
    for (const f of FAVORITE_FACTS) expect(f.trim()).not.toBe('');
  });

  it('duplicate id is rejected by name', () => {
    const dup = [{ ...card('a') }, { ...card('a') }];
    expect(() => loadSeed(dup)).toThrow('roster seed: duplicate id a');
  });

  it('roles do not use show character names', () => {
    for (const c of loadSeed())
      expect(c.role).not.toMatch(/Michael|Dwight|Jim|Pam|Scott|Schrute|Halpert|Beesly/);
  });

  it('accepts a hand-edited seed passed in', () => {
    const custom = [card('x', { spriteIndex: 3 }), card('y', { spriteIndex: 4 })];
    expect(loadSeed(custom)).toEqual(custom);
  });

  it.each(['id', 'spriteIndex', 'name', 'role', 'department', 'favoriteFact'] as const)(
    'missing %s throws naming the card and field',
    (field) => {
      const broken: Record<string, unknown> = { ...card('b') };
      delete broken[field];
      // A card with no id is reported by its position instead.
      const label = field === 'id' ? '#0' : 'b';
      expect(() => loadSeed([broken])).toThrow(`roster seed: ${label} missing ${field}`);
    },
  );

  it('a field of the wrong type counts as missing', () => {
    expect(() => loadSeed([{ ...card('c'), spriteIndex: '3' }])).toThrow(
      'roster seed: c missing spriteIndex',
    );
    expect(() => loadSeed([{ ...card('c'), name: 42 }])).toThrow('roster seed: c missing name');
  });

  it('rejects negative, fractional, or non-finite sprite indexes', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => loadSeed([card('d', { spriteIndex: bad })])).toThrow(
        'roster seed: d missing spriteIndex',
      );
    }
  });

  it('rejects empty strings', () => {
    expect(() => loadSeed([card('e', { name: '' })])).toThrow('roster seed: e missing name');
  });

  it('rejects input that is not an array of objects', () => {
    expect(() => loadSeed({})).toThrow('roster seed: expected an array');
    expect(() => loadSeed([null])).toThrow('roster seed: #0 is not an object');
  });

  it('returns copies that do not alias the input', () => {
    const input = [{ ...card('f'), extra: 'ignored' }];
    const [out] = loadSeed(input);
    expect(out).toEqual(card('f'));
    expect(out).not.toBe(input[0]);
  });
});
