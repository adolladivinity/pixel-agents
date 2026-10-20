/** One fixed employee on the roster. Stats are stored separately, keyed by `id`. */
export interface CardDef {
  /** Stable slug. Stats are keyed by this, so never reuse or rename one casually. */
  id: string;
  /** Position in the combined character list (bundled six first, then external asset dirs). */
  spriteIndex: number;
  name: string;
  role: string;
  department: string;
  favoriteFact: string;
}

/** Persisted per-card numbers. Never reset, never goes down. Timestamps are ISO strings ('' = never seen). */
export interface CardStats {
  xp: number;
  workedSeconds: number;
  tasksCompleted: number;
  lifetimeTokens: number;
  firstSeen: string;
  lastSeen: string;
}

/** Amounts to add to a card's stats. Negative values are ignored by the store. */
export type CardDelta = Partial<
  Pick<CardStats, 'xp' | 'workedSeconds' | 'tasksCompleted' | 'lifetimeTokens'>
>;
