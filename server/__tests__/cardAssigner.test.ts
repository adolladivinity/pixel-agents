import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardAssigner } from '../src/roster/cardAssigner.js';
import { RosterStore } from '../src/roster/rosterStore.js';
import { loadSeed } from '../src/roster/seed.js';
import type { CardDef } from '../src/roster/types.js';

let dir: string;
let file: string;

function store(processId: string): RosterStore {
  return new RosterStore({ filePath: file, processId, log: () => {} });
}

function card(id: string, i = 0): CardDef {
  return {
    id,
    spriteIndex: i,
    name: id,
    role: 'r',
    department: 'd',
    favoriteFact: 'f',
  };
}

/** Deterministic PRNG so tests don't flake. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-assigner-'));
  file = path.join(dir, 'roster.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('CardAssigner', () => {
  it('draws distinct cards until exhausted, then hands out Temps', () => {
    const cards = loadSeed();
    expect(cards).toHaveLength(30);
    const a = new CardAssigner(cards, store('A'), seeded(1));
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const got = a.assign(`s${i}`, { isLead: true });
      expect(got.isTemp).toBe(false);
      ids.add(got.card!.id);
    }
    expect(ids.size).toBe(30);
    const extra = a.assign('s30', { isLead: true });
    expect(extra.card).toBeNull();
    expect(extra.isTemp).toBe(true);
  });

  it('returns the existing assignment for the same session id (hooks + JSONL dedupe)', () => {
    const a = new CardAssigner(loadSeed(), store('A'), seeded(2));
    const first = a.assign('s', { isLead: true });
    const second = a.assign('s', { isLead: true });
    expect(second).toBe(first);
    expect(a.cardFor('s')).toBe(first);
  });

  it('release returns the card to the pool', () => {
    const a = new CardAssigner([card('only')], store('A'));
    const first = a.assign('A', { isLead: true });
    expect(first.card?.id).toBe('only');
    expect(a.assign('B', { isLead: true }).isTemp).toBe(true);
    a.release('B');
    a.release('A');
    expect(a.cardFor('A')).toBeUndefined();
    expect(a.assign('C', { isLead: false }).card?.id).toBe('only');
  });

  it('release frees the card in the store too, so another process can take it', () => {
    const other = store('other');
    const a = new CardAssigner([card('only')], store('A'));
    a.assign('s', { isLead: true });
    expect(other.tryClaim('only', 'x')).toBe(false);
    a.release('s');
    expect(other.tryClaim('only', 'x')).toBe(true);
  });

  it('release of an unknown session is a no-op', () => {
    const a = new CardAssigner([card('c')], store('A'));
    expect(() => a.release('nope')).not.toThrow();
  });

  it('re-attaches the previous card after a reload', () => {
    const cards = loadSeed();
    const a = new CardAssigner(cards, store('A'), seeded(3));
    const got = a.assign('s', { isLead: true, previousCardId: cards[2].id });
    expect(got.card?.id).toBe(cards[2].id);
  });

  it('draws fresh when the previous card is no longer in the seed', () => {
    const a = new CardAssigner([card('c1'), card('c2')], store('A'), seeded(4));
    const got = a.assign('s', { isLead: true, previousCardId: 'removed' });
    expect(got.isTemp).toBe(false);
    expect(['c1', 'c2']).toContain(got.card?.id);
  });

  it('draws fresh when the previous card is held by another session here', () => {
    const a = new CardAssigner([card('c1'), card('c2')], store('A'), seeded(5));
    a.assign('first', { isLead: true, previousCardId: 'c1' });
    const got = a.assign('second', { isLead: true, previousCardId: 'c1' });
    expect(got.card?.id).toBe('c2');
  });

  it('draws fresh when the previous card is held by another process', () => {
    const other = store('other');
    expect(other.tryClaim('c1', 'x')).toBe(true);
    const a = new CardAssigner([card('c1'), card('c2')], store('A'), seeded(6));
    expect(a.assign('s', { isLead: true, previousCardId: 'c1' }).card?.id).toBe('c2');
  });

  it('never draws a card another process holds', () => {
    const cards = loadSeed();
    const other = store('other');
    const held = cards[0].id;
    expect(other.tryClaim(held, 'x')).toBe(true);
    for (let round = 0; round < 5; round++) {
      const a = new CardAssigner(cards, store(`A${round}`), seeded(100 + round));
      for (let i = 0; i < 29; i++) {
        expect(a.assign(`s${i}`, { isLead: true }).card?.id).not.toBe(held);
      }
      // The 29 free cards are gone; the 30th agent is a Temp rather than stealing the held card.
      expect(a.assign('last', { isLead: true }).isTemp).toBe(true);
      for (let i = 0; i < 29; i++) a.release(`s${i}`);
    }
  });

  it('random draw is not session-bound', () => {
    const a = new CardAssigner(loadSeed(), store('A'), seeded(7));
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      seen.add(a.assign('same-session', { isLead: true }).card!.id);
      a.release('same-session');
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('uses the injected random to pick among free cards', () => {
    const cards = [card('c1'), card('c2'), card('c3')];
    const low = new CardAssigner(cards, store('low'), () => 0);
    expect(low.assign('s', { isLead: true }).card?.id).toBe('c1');
    const high = new CardAssigner(cards, store('high'), () => 0.999999);
    // c1 is held by `low`, so the free pool is [c2, c3].
    expect(high.assign('s', { isLead: true }).card?.id).toBe('c3');
  });

  it('falls back to a Temp when every claim attempt fails, with a bounded number of tries', () => {
    let attempts = 0;
    const failing = {
      tryClaim: () => {
        attempts++;
        return false;
      },
      release: () => {},
      claimedByOthers: () => new Set<string>(),
    };
    const a = new CardAssigner(loadSeed(), failing, seeded(8));
    const got = a.assign('s', { isLead: true });
    expect(got).toEqual({ sessionId: 's', card: null, isTemp: true, isLead: true });
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(30);
  });

  it('records isLead and keeps a Temp deduped by session id', () => {
    const a = new CardAssigner([], store('A'));
    const t = a.assign('s', { isLead: false });
    expect(t).toEqual({ sessionId: 's', card: null, isTemp: true, isLead: false });
    expect(a.assign('s', { isLead: true })).toBe(t);
  });

  it('keeps working in read-only (corrupt file) mode', () => {
    fs.writeFileSync(file, '{ not json');
    const s = store('A');
    expect(s.readOnly).toBe(true);
    const a = new CardAssigner([card('c1'), card('c2')], s, seeded(9));
    const one = a.assign('one', { isLead: true });
    const two = a.assign('two', { isLead: true });
    expect(new Set([one.card?.id, two.card?.id])).toEqual(new Set(['c1', 'c2']));
  });
});
