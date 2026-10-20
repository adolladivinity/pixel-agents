import type { RosterStore } from './rosterStore.js';
import type { CardDef } from './types.js';

/** What the assigner needs from the stats store; keeps tests free to fake it. */
export type ClaimStore = Pick<RosterStore, 'tryClaim' | 'release' | 'claimedByOthers'>;

export interface Assignment {
  sessionId: string;
  /** null for a Temp (pool exhausted, or every claim attempt failed). */
  card: CardDef | null;
  isTemp: boolean;
  /** Top-level session (true) versus subagent/teammate (false). Fixed at assignment time. */
  isLead: boolean;
}

/**
 * Claim attempts per assign. A failed attempt is normally a race with another window,
 * so a few retries cover it; a store that fails every time (roster.json unreadable)
 * must not make each new agent block for 30 sequential file reads.
 */
const MAX_CLAIM_ATTEMPTS = 6;

/**
 * Hands each agent one character card for its whole life.
 *
 * The draw is random at assignment time and never tied to the session, project or
 * subagent type. Keyed by session id so a second sighting of the same session (hooks and
 * the JSONL scanner both detecting it) gets the existing assignment. The claim in the
 * shared store keeps other Pixel Agents windows from drawing the same card.
 */
export class CardAssigner {
  private readonly cardsById = new Map<string, CardDef>();
  private readonly bySession = new Map<string, Assignment>();
  /** cardId -> sessionId for cards this assigner holds. */
  private readonly heldBy = new Map<string, string>();

  constructor(
    cards: CardDef[],
    private readonly store: ClaimStore,
    private readonly random: () => number = Math.random,
  ) {
    for (const card of cards) this.cardsById.set(card.id, card);
  }

  assign(sessionId: string, opts: { isLead: boolean; previousCardId?: string }): Assignment {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing;

    const card = this.reattach(sessionId, opts.previousCardId) ?? this.draw(sessionId);
    const assignment: Assignment = {
      sessionId,
      card,
      isTemp: card === null,
      isLead: opts.isLead,
    };
    this.bySession.set(sessionId, assignment);
    return assignment;
  }

  release(sessionId: string): void {
    const assignment = this.bySession.get(sessionId);
    if (!assignment) return;
    this.bySession.delete(sessionId);
    if (assignment.card) {
      this.heldBy.delete(assignment.card.id);
      this.store.release(assignment.card.id);
    }
  }

  cardFor(sessionId: string): Assignment | undefined {
    return this.bySession.get(sessionId);
  }

  /** Re-claim the card persisted with the agent, if it still exists and is free. */
  private reattach(sessionId: string, previousCardId: string | undefined): CardDef | null {
    if (!previousCardId) return null;
    const card = this.cardsById.get(previousCardId);
    if (!card || this.heldBy.has(card.id)) return null;
    return this.claim(card, sessionId) ? card : null;
  }

  /** Uniform random pick among cards nobody holds; tries a bounded number of candidates. */
  private draw(sessionId: string): CardDef | null {
    const others = this.store.claimedByOthers();
    const free = [...this.cardsById.values()].filter(
      (c) => !this.heldBy.has(c.id) && !others.has(c.id),
    );
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS && free.length > 0; attempt++) {
      const index = Math.min(free.length - 1, Math.floor(this.random() * free.length));
      const [candidate] = free.splice(index, 1);
      if (this.claim(candidate, sessionId)) return candidate;
    }
    return null;
  }

  private claim(card: CardDef, sessionId: string): boolean {
    if (!this.store.tryClaim(card.id, sessionId)) return false;
    this.heldBy.set(card.id, sessionId);
    return true;
  }
}
