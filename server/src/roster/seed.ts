import favoriteFacts from './data/favorite-facts.json';
import rosterSeed from './data/roster-seed.json';
import type { CardDef } from './types.js';

/** Silly, workplace-safe one-liners. Each seed card's fact is picked from here and then fixed. */
export const FAVORITE_FACTS: readonly string[] = favoriteFacts;

const STRING_FIELDS = ['name', 'role', 'department', 'favoriteFact'] as const;

/**
 * Validate a roster seed and return it as `CardDef[]`. Defaults to the bundled seed.
 * The seed is hand-editable, so every field must be present with the right type and
 * ids must be unique (stats are keyed by id). Failures name the card and field.
 */
export function loadSeed(json: unknown = rosterSeed): CardDef[] {
  if (!Array.isArray(json)) {
    throw new Error('roster seed: expected an array');
  }
  const seen = new Set<string>();
  const cards: CardDef[] = [];
  json.forEach((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`roster seed: #${index} is not an object`);
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== 'string' || raw.id === '') {
      throw new Error(`roster seed: #${index} missing id`);
    }
    const id = raw.id;
    if (seen.has(id)) {
      throw new Error(`roster seed: duplicate id ${id}`);
    }
    seen.add(id);
    const spriteIndex = raw.spriteIndex;
    if (typeof spriteIndex !== 'number' || !Number.isInteger(spriteIndex) || spriteIndex < 0) {
      throw new Error(`roster seed: ${id} missing spriteIndex`);
    }
    const card: CardDef = {
      id,
      spriteIndex,
      name: '',
      role: '',
      department: '',
      favoriteFact: '',
    };
    for (const field of STRING_FIELDS) {
      const value = raw[field];
      if (typeof value !== 'string' || value === '') {
        throw new Error(`roster seed: ${id} missing ${field}`);
      }
      card[field] = value;
    }
    cards.push(card);
  });
  return cards;
}
