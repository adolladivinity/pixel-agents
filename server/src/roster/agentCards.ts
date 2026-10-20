import type { AgentStateStore } from '../agentStateStore.js';
import type { AgentState, PersistedAgent } from '../types.js';
import type { Assignment, CardAssigner } from './cardAssigner.js';

export interface AgentCardsOptions {
  /** A CardAssigner, or a factory called on the first agent (so nothing opens roster.json early). */
  assigner: CardAssigner | (() => CardAssigner);
  /** Tool names that spawn a sub-agent (provider.subagentToolNames). */
  subagentTools: ReadonlySet<string>;
  /** Persisted agents as the previous process left them; supplies cards for re-detected sessions. */
  loadPersisted: () => PersistedAgent[];
}

interface Holder {
  /** CardAssigner key (session id, or a derived key for sub-agents). */
  key: string;
  /** For tool holders: the parent agent that spawned the sub-agent. */
  parentId?: number;
  toolId?: string;
}

const agentHolder = (id: number) => `a:${id}`;
const toolHolder = (parentId: number, toolId: string) => `t:${parentId}:${toolId}`;
const toolKey = (sessionId: string, toolId: string) => `${sessionId}#tool-${toolId}`;

/**
 * Ties roster cards to the lifetime of agents. AgentRuntime attaches it to the main agent
 * store and to the shadow store of watched background sub-agents.
 *
 * Who holds a card:
 * - a top-level agent, keyed by its session id (so hooks + the JSONL scanner share one card);
 * - a teammate or other agent with a lead, keyed by its own id (it can share the lead's session);
 * - a sub-agent, keyed `${sessionId}#tool-${toolId}`. The webview shows every Task/Agent tool
 *   call as a "Subtask" character even when no server-side agent exists, so the draw is made when
 *   that tool starts and released when it ends. A background spawn that is also watched or
 *   promoted to a real agent uses the same key, so it is still one card.
 *
 * Several holders may share a key; the card is released when the last one goes.
 */
export class AgentCards {
  private assigner: CardAssigner | undefined;
  private source: CardAssigner | (() => CardAssigner) | undefined;
  private readonly holders = new Map<string, Holder>();
  /** Session id -> card from the previous process's persisted state, each used at most once.
   *  Read at construction: restoring agents rewrites the persisted list, dropping any entry whose
   *  terminal or transcript is gone. */
  private readonly previousBySession = new Map<string, string>();

  constructor(private readonly opts: AgentCardsOptions) {
    this.source = opts.assigner;
    try {
      for (const p of opts.loadPersisted()) {
        if (p.cardId && p.sessionId && p.leadAgentId === undefined) {
          this.previousBySession.set(p.sessionId, p.cardId);
        }
      }
    } catch {
      /* unreadable persisted state: nothing to re-attach */
    }
  }

  /** Subscribe to a store's add/remove events. `watchTools` also follows sub-agent tool calls. */
  attach(store: AgentStateStore, watchTools = false): void {
    store.on('agentAdded', (id, agent) => this.onAgentAdded(id, agent));
    store.on('agentRemoved', (id) => this.onAgentRemoved(id));
    if (watchTools) {
      store.on('broadcast', (msg) => this.onBroadcast(store, msg));
    }
  }

  getAssignment(agentId: number): Assignment | undefined {
    return this.lookup(agentHolder(agentId));
  }

  /** The card held by the sub-agent a parent started with the given tool call. */
  getToolAssignment(parentAgentId: number, toolId: string): Assignment | undefined {
    return this.lookup(toolHolder(parentAgentId, toolId));
  }

  private lookup(holderId: string): Assignment | undefined {
    const holder = this.holders.get(holderId);
    return holder ? this.assigner?.cardFor(holder.key) : undefined;
  }

  /** Resolve the assigner on first use. A failing factory disables the roster, never the agent. */
  private resolve(): CardAssigner | undefined {
    if (this.assigner) return this.assigner;
    const source = this.source;
    if (!source) return undefined;
    this.source = undefined; // one attempt: a broken roster stays off
    try {
      this.assigner = typeof source === 'function' ? source() : source;
    } catch (err) {
      console.warn(`[Pixel Agents] Roster disabled: ${String(err)}`);
    }
    return this.assigner;
  }

  private previousCard(sessionId: string): string | undefined {
    const cardId = this.previousBySession.get(sessionId);
    this.previousBySession.delete(sessionId);
    return cardId;
  }

  private draw(holderId: string, holder: Holder, isLead: boolean, previousCardId?: string) {
    const assigner = this.resolve();
    if (!assigner) return undefined;
    const assignment = assigner.assign(holder.key, { isLead, previousCardId });
    this.holders.set(holderId, holder);
    return assignment;
  }

  private onAgentAdded(id: number, agent: AgentState): void {
    try {
      const isLead = agent.leadAgentId === undefined;
      let key: string;
      if (isLead) key = agent.sessionId;
      else if (agent.spawnToolUseId) key = toolKey(agent.sessionId, agent.spawnToolUseId);
      else key = `${agent.sessionId}#agent-${id}`;
      // A re-detected top-level session (its persisted agent was not restored, e.g. the
      // terminal is gone but the transcript is live) gets its old card back by session id.
      const previous = agent.cardId ?? (isLead ? this.previousCard(agent.sessionId) : undefined);
      const assignment = this.draw(agentHolder(id), { key }, isLead, previous);
      if (assignment) agent.cardId = assignment.card?.id;
    } catch (err) {
      console.warn(`[Pixel Agents] Card assignment failed for agent ${id}: ${String(err)}`);
    }
  }

  private onAgentRemoved(id: number): void {
    this.drop(agentHolder(id));
    for (const [holderId, holder] of [...this.holders]) {
      if (holder.parentId === id) this.drop(holderId);
    }
  }

  private onBroadcast(store: AgentStateStore, msg: Record<string, unknown>): void {
    const parentId = msg.id;
    if (typeof parentId !== 'number') return;
    try {
      switch (msg.type) {
        case 'agentToolStart': {
          const toolId = msg.toolId;
          const toolName = msg.toolName;
          if (typeof toolId !== 'string' || typeof toolName !== 'string') return;
          // Named teammates become real agents of their own and draw there.
          if (!this.opts.subagentTools.has(toolName) || msg.isTeammateSpawn) return;
          const parent = store.get(parentId);
          if (!parent) return;
          this.draw(
            toolHolder(parentId, toolId),
            { key: toolKey(parent.sessionId, toolId), parentId, toolId },
            false,
          );
          return;
        }
        case 'agentToolDone':
          if (typeof msg.toolId === 'string') this.drop(toolHolder(parentId, msg.toolId));
          return;
        case 'subagentClear':
          if (typeof msg.parentToolId === 'string') {
            this.drop(toolHolder(parentId, msg.parentToolId));
          }
          return;
        case 'agentToolsClear': {
          // Turn end drops foreground spawns without a per-tool done; background ones live on.
          const parent = store.get(parentId);
          for (const [holderId, holder] of [...this.holders]) {
            if (holder.parentId !== parentId || holder.toolId === undefined) continue;
            if (parent?.backgroundAgentToolIds.has(holder.toolId)) continue;
            this.drop(holderId);
          }
          return;
        }
      }
    } catch (err) {
      console.warn(`[Pixel Agents] Sub-agent card update failed: ${String(err)}`);
    }
  }

  private drop(holderId: string): void {
    const holder = this.holders.get(holderId);
    if (!holder) return;
    this.holders.delete(holderId);
    // Hooks + scanner (or a tool and its watched agent) can share a key: keep the card until
    // the last holder leaves.
    for (const other of this.holders.values()) {
      if (other.key === holder.key) return;
    }
    try {
      this.assigner?.release(holder.key);
    } catch (err) {
      console.warn(`[Pixel Agents] Card release failed: ${String(err)}`);
    }
  }
}
