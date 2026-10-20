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
