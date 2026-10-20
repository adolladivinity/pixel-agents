import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';

import type { AgentRoster, RosterStatus } from '../../../core/src/messages.js';
import type { AgentEvent } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { LAYOUT_FILE_DIR } from '../constants.js';
import type { AgentState } from '../types.js';
import { ActivityTracker, type TrackedStatus } from './activityTracker.js';
import type { AgentCardsListener, CardHolderInfo } from './agentCards.js';
import { CardAssigner } from './cardAssigner.js';
import { RosterStore } from './rosterStore.js';
import { loadSeed } from './seed.js';
import type { RosterSink } from './sink.js';
import { TokenCounter } from './tokenCounter.js';
import type { CardDef, CardStats } from './types.js';
import { levelInfo } from './xp.js';

export type { RosterSink } from './sink.js';

/** The shared stats file every Pixel Agents process on this machine reads and writes. */
export function defaultRosterPath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, 'roster.json');
}

const TICK_MS = 1_000;
const FLUSH_MS = 10_000;
const HEARTBEAT_MS = 20_000;
/**
 * A real user prompt arriving this long after the open task started means the old turn was cut
 * off (Esc fires no Stop hook), so the new prompt starts a fresh task. Shorter than this it is
 * the transcript echo of a prompt a hook already started, or a very quick follow-up.
 */
const PROMPT_RESTART_AFTER_MS = 3_000;
/** Markers of user lines the harness writes that the user never typed. */
const NOT_A_PROMPT_MARKERS = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
];

export interface RosterOptions {
  /** Stats file. Defaults to ~/.pixel-agents/roster.json. Tests pass a temp path. */
  filePath?: string;
  /** Identity of this process in the file's in-use markers. Unique per Roster by default. */
  processId?: string;
  /** Card pool. Defaults to the bundled seed. */
  cards?: CardDef[];
  random?: () => number;
  /** One clock for events, ticks and the store. Defaults to Date.now. */
  now?: () => number;
  /** Warning sink, e.g. an output channel. Defaults to console.warn. */
  log?: (msg: string) => void;
  /** Run the 1 s tick, 10 s flush and 20 s heartbeat timers. Default true; tests drive `tick()`. */
  timers?: boolean;
}

/** Address of a panel selection: a top-level agent/teammate, or a Task-tool sub-agent. */
export interface PanelSelection {
  agentId: number;
  parentToolId?: string;
}

/**
 * The selection in a `rosterPanelSelect` client message, or null to close the panel. Anything
 * that is not a whole-number agent id (the client is not trusted to be well-formed) closes it.
 */
export function parsePanelSelection(msg: Record<string, unknown>): PanelSelection | null {
  const agentId = msg.agentId;
  if (typeof agentId !== 'number' || !Number.isInteger(agentId)) return null;
  return typeof msg.parentToolId === 'string' && msg.parentToolId !== ''
    ? { agentId, parentToolId: msg.parentToolId }
    : { agentId };
}

interface Identity {
  id: number;
  parentToolId?: string;
}

interface Entry {
  key: string;
  isLead: boolean;
  /** Webview addresses of this card, with how many holders (agent, tool call, watched
   *  transcript) currently stand behind each: a foreground sub-agent has two. */
  identities: Map<string, { identity: Identity; holders: number }>;
  /** Main-store agent whose project folder applies. */
  ownerId: number;
  /** When the key was first assigned. A sub-agent's task runs from here. */
  startedAt: number;
  /** Tool status texts currently shown for this holder, oldest first. */
  tools: Map<string, string>;
  /** Transcripts counted for this key, so their counters can be dropped with it. */
  counterKeys: Set<string>;
}

interface Core {
  store: RosterStore;
  assigner: CardAssigner;
  tracker: ActivityTracker;
  timers: ReturnType<typeof setInterval>[];
}

const identityKey = (i: Identity) => `${i.id}:${i.parentToolId ?? ''}`;
const toolRef = (id: number, parentToolId: string) => `${id}:${parentToolId}`;

const ZERO_STATS: CardStats = {
  xp: 0,
  workedSeconds: 0,
  tasksCompleted: 0,
  lifetimeTokens: 0,
  firstSeen: '',
  lastSeen: '',
};

/** Same derivation fileWatcher uses to name an agent's Directory from its Claude project dir. */
function projectNameOf(agent: AgentState | undefined): string {
  if (!agent) return '';
  if (agent.directoryName) return agent.directoryName;
  const base = path.basename(agent.projectDir ?? '');
  const parts = base.replace(/^-+/, '').split('-');
  return parts[parts.length - 1] || base;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Whether a transcript user record is something the user typed. Meta lines, compaction summaries
 * and slash-command / local-command output are user records too but never start a turn. A
 * missing record (older callers) counts as a prompt.
 */
export function isRealPrompt(record: unknown): boolean {
  if (!isRecord(record)) return true;
  if (record.isMeta === true || record.isCompactSummary === true) return false;
  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content ?? record.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && typeof block.text === 'string') text += block.text;
    }
  }
  return !NOT_A_PROMPT_MARKERS.some((m) => text.includes(m));
}

/**
 * The running roster: shared stats store, card assigner, activity tracker and the three timers,
 * plus the `agentRoster` message sent to clients. Everything is created lazily on the first card
 * so a run with no agents never touches roster.json or starts a timer.
 *
 * How it is fed (AgentRuntime wires all of it):
 * - card lifetime: `cardsListener`, called by AgentCards when an agent/sub-agent gets or loses a card;
 * - status, tool text, permission: the main store's `broadcast` events (`attach`);
 * - hook events and transcript lines: the `RosterSink` methods.
 *
 * Turn counting. A task is counted at its END, from exactly one source per agent: the `Stop` hook once
 * hooks have been delivered for it, otherwise the transcript heuristic's own "waiting" status. A task
 * STARTS on a hook prompt event if one arrives (stale installs only: the current installer does not
 * subscribe to UserPromptSubmit) or on a user prompt in the transcript, whichever comes first; a start
 * within PROMPT_RESTART_AFTER_MS of an open task is ignored, so the two never double count. A later
 * prompt while a task is still open means the turn was interrupted: it restarts without counting.
 * Meta, compaction and local-command user lines never start a task.
 */
export class Roster implements RosterSink {
  readonly cardsListener: AgentCardsListener;

  private core: Core | undefined;
  private mainStore: AgentStateStore | undefined;
  private disposed = false;
  private readonly entries = new Map<string, Entry>();
  /** Main-store agent id -> card key. Fixed at assignment, so a /clear (new session id) keeps it. */
  private readonly byAgentId = new Map<number, string>();
  /** `${parentAgentId}:${toolId}` -> card key, for Task-tool and watched sub-agents. */
  private readonly byTool = new Map<string, string>();
  /** One token counter per transcript file (and per embedded sub-agent stream). */
  private readonly counters = new Map<string, TokenCounter>();
  /** clientKey -> the agent whose panel that client has open. */
  private readonly selections = new Map<unknown, PanelSelection>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: RosterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.cardsListener = {
      assigned: (info) => this.onAssigned(info),
      dropping: (info, last) => this.onDropping(info, last),
    };
  }

  // ── Setup ──

  /** The card assigner, opening roster.json and starting the timers on first use. */
  getAssigner(): CardAssigner {
    return this.ensureCore().assigner;
  }

  /** Follow the main store's status and tool broadcasts, and send `agentRoster` on it. */
  attach(store: AgentStateStore): void {
    this.mainStore = store;
    store.on('broadcast', (msg) => this.guard(() => this.onBroadcast(msg)));
  }

  private ensureCore(): Core {
    if (this.core) return this.core;
    const store = new RosterStore({
      filePath: this.opts.filePath ?? defaultRosterPath(),
      // Unique per process and per construction: two windows must never share an identity.
      processId: this.opts.processId ?? `${process.pid}-${randomUUID().slice(0, 8)}`,
      now: this.opts.now,
      log: this.log,
    });
    const assigner = new CardAssigner(this.opts.cards ?? loadSeed(), store, this.opts.random);
    const tracker = new ActivityTracker(store, (key) => assigner.cardFor(key)?.card?.id ?? null);
    const timers: ReturnType<typeof setInterval>[] = [];
    if (this.opts.timers !== false) {
      timers.push(setInterval(() => this.guard(() => this.tick()), TICK_MS));
      timers.push(setInterval(() => this.guard(() => store.flush()), FLUSH_MS));
      timers.push(setInterval(() => this.guard(() => store.heartbeat()), HEARTBEAT_MS));
      // A pending timer must never keep the CLI or extension host alive.
      for (const t of timers) t.unref?.();
    }
    this.core = { store, assigner, tracker, timers };
    return this.core;
  }

  /**
   * Final flush and release at shutdown. AgentRuntime.dispose() removes every agent first (each
   * removal settles and flushes its card); this stops the timers and cleans up anything left.
   * Synchronous, so it can run from VS Code's deactivate.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const core = this.core;
    if (!core) return;
    for (const t of core.timers) clearInterval(t);
    const t = this.now();
    const keys = [...this.entries.keys()];
    for (const key of keys) core.tracker.removed(key, t);
    // Flush while the claims are still held, then release them: a crash between the two leaves
    // claims that go stale on their own, never stats that were lost.
    core.store.flush();
    for (const key of keys) core.assigner.release(key);
    this.entries.clear();
    this.byAgentId.clear();
    this.byTool.clear();
    this.counters.clear();
    this.selections.clear();
    core.store.flush();
  }

  // ── Client selection and resend ──

  /** A client opened (or, with null, closed) the panel for an agent. Sends it once at once. */
  setPanelSelection(clientKey: unknown, selection: PanelSelection | null): void {
    if (selection === null) {
      this.selections.delete(clientKey);
      return;
    }
    this.selections.set(clientKey, selection);
    this.guard(() => this.sendSelection(selection));
  }

  /** Forget a client that went away. */
  clearPanelSelection(clientKey: unknown): void {
    this.selections.delete(clientKey);
  }

  /** The current `agentRoster` for every card holder, for a client that just connected. */
  snapshotMessages(): AgentRoster[] {
    const messages: AgentRoster[] = [];
    for (const entry of this.entries.values()) {
      for (const { identity } of entry.identities.values()) {
        const msg = this.build(entry, identity);
        if (msg) messages.push(msg);
      }
    }
    return messages;
  }

  /** The 1 s tick: bank working time, then refresh every open panel. */
  tick(): void {
    const core = this.core;
    if (!core || this.disposed) return;
    core.tracker.tick(this.now());
    const seen = new Set<string>();
    for (const selection of this.selections.values()) {
      const id = `${selection.agentId}:${selection.parentToolId ?? ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      this.sendSelection(selection);
    }
  }

  // ── AgentCards listener ──

  private onAssigned(info: CardHolderInfo): void {
    if (this.disposed) return;
    const core = this.ensureCore();
    const t = this.now();
    let entry = this.entries.get(info.key);
    if (!entry) {
      entry = {
        key: info.key,
        isLead: info.isLead,
        identities: new Map(),
        ownerId: info.ownerId,
        startedAt: t,
        tools: new Map(),
        counterKeys: new Set(),
      };
      this.entries.set(info.key, entry);
      core.tracker.activity(info.key, t);
      // A sub-agent exists only while it works; a top-level agent waits for its first event.
      if (!info.isLead) core.tracker.status(info.key, 'working', t);
    }
    const known = entry.identities.get(identityKey(info.identity));
    if (known) known.holders++;
    else entry.identities.set(identityKey(info.identity), { identity: info.identity, holders: 1 });
    if (info.agentId !== undefined) this.byAgentId.set(info.agentId, info.key);
    if (info.identity.parentToolId !== undefined) {
      this.byTool.set(toolRef(info.identity.id, info.identity.parentToolId), info.key);
      const text = this.mainStore
        ?.get(info.ownerId)
        ?.activeToolStatuses.get(info.identity.parentToolId);
      if (text) entry.tools.set(info.identity.parentToolId, text);
    }
    // Deferred past the store event that caused it, so a client sees agentCreated before this.
    const identity = info.identity;
    queueMicrotask(() => this.guard(() => this.send(entry, identity)));
  }

  private onDropping(info: CardHolderInfo, last: boolean): void {
    const core = this.core;
    const entry = this.entries.get(info.key);
    if (!core || !entry) return;
    const known = entry.identities.get(identityKey(info.identity));
    const identityGone = !known || --known.holders <= 0;
    if (identityGone) entry.identities.delete(identityKey(info.identity));
    if (info.agentId !== undefined && this.byAgentId.get(info.agentId) === info.key) {
      this.byAgentId.delete(info.agentId);
    }
    if (identityGone && info.identity.parentToolId !== undefined) {
      this.byTool.delete(toolRef(info.identity.id, info.identity.parentToolId));
    }
    if (!last) return;
    // The card is still assigned here, so these writes land on it.
    const t = this.now();
    if (!entry.isLead) core.tracker.subagentEnded(info.key, entry.startedAt, t);
    core.tracker.removed(info.key, t);
    core.store.flush();
    for (const counterKey of entry.counterKeys) this.counters.delete(counterKey);
    this.entries.delete(info.key);
  }

  // ── RosterSink: hooks and transcript ──

  hookEvent(agentId: number, agent: AgentState, kind: AgentEvent['kind']): void {
    this.guard(() => {
      const key = this.keyFor(agentId, agent);
      if (!key || !this.core) return;
      const t = this.now();
      const { tracker } = this.core;
      tracker.activity(key, t);
      const entry = this.entries.get(key);
      if (!entry?.isLead) return;
      if (kind === 'promptSubmit') {
        tracker.taskStart(key, t);
      } else if (kind === 'turnEnd') {
        tracker.taskEnd(key, t);
        this.sendAll(entry);
      }
    });
  }

  transcriptPrompt(agentId: number, agent: AgentState, record?: unknown): void {
    this.guard(() => {
      const key = this.keyFor(agentId, agent);
      const entry = key ? this.entries.get(key) : undefined;
      if (!key || !entry?.isLead || !this.core) return;
      // Meta, compaction summaries and local-command lines (/clear, shell output) are not turns.
      if (!isRealPrompt(record)) return;
      const { tracker } = this.core;
      const t = this.now();
      tracker.activity(key, t);
      const snap = tracker.snapshot(key);
      if (snap.taskStartedAt !== null && snap.taskEndedAt === null) {
        // A hook prompt event may have started this turn a moment ago: one task per turn.
        if (t - snap.taskStartedAt < PROMPT_RESTART_AFTER_MS) return;
        // A new prompt well into an open task means the old turn was interrupted (Esc fires no
        // Stop hook). Restart without counting it, like the tracker does for a missed Stop.
      }
      tracker.taskStart(key, t);
    });
  }

  transcriptRecord(agentId: number, agent: AgentState, record: unknown): void {
    this.guard(() => {
      const key = this.keyFor(agentId, agent);
      if (!key) return;
      // Another agent's turn inlined in this transcript (see contextUsage): not ours.
      if (isRecord(record) && record.isSidechain === true && agent.sawMainChainUsage) return;
      this.count(key, `${agent.jsonlFile}`, record);
    });
  }

  subagentRecord(
    parentAgentId: number,
    parentAgent: AgentState,
    parentToolId: string,
    record: unknown,
  ): void {
    this.guard(() => {
      const key = this.byTool.get(toolRef(parentAgentId, parentToolId));
      if (!key) return;
      this.count(key, `${parentAgent.jsonlFile}#sub-${parentToolId}`, record);
    });
  }

  /** One record from a transcript: keeps the key active and adds its tokens to the key's card. */
  private count(key: string, transcriptCounterKey: string, record: unknown): void {
    const core = this.core;
    const entry = this.entries.get(key);
    if (!core || !entry) return;
    core.tracker.activity(key, this.now());
    // A sub-agent can be seen in two streams at once (agent_progress records on the lead, and its
    // own watched sidecar transcript). Both feed this card, so they share one counter and a message
    // id seen in both counts once. A lead has a single stream per transcript file.
    const counterKey = entry.isLead ? transcriptCounterKey : `card:${key}`;
    let counter = this.counters.get(counterKey);
    if (!counter) {
      counter = new TokenCounter();
      this.counters.set(counterKey, counter);
      entry.counterKeys.add(counterKey);
    }
    const delta = counter.addRecord(record);
    if (delta) core.tracker.tokens(key, delta.deltaTokens);
  }

  // ── Main store broadcasts ──

  private onBroadcast(msg: Record<string, unknown>): void {
    const core = this.core;
    if (!core || this.disposed) return;
    const id = msg.id;
    if (typeof id !== 'number') return;
    const t = this.now();
    switch (msg.type) {
      case 'agentStatus': {
        const key = this.byAgentId.get(id);
        const entry = key ? this.entries.get(key) : undefined;
        if (!key || !entry) return;
        if (msg.status === 'active') {
          core.tracker.status(key, 'working', t);
        } else if (msg.status === 'waiting') {
          core.tracker.status(key, msg.awaitingInput === true ? 'waiting' : 'idle', t);
          // The JSONL heuristic's turn end (turn_duration, or the text-idle timer). With hooks
          // delivered the Stop hook counts the turn instead.
          const agent = this.mainStore?.get(id);
          if (entry.isLead && agent && !agent.hookDelivered) core.tracker.taskEnd(key, t);
        }
        this.sendAll(entry);
        return;
      }
      case 'agentToolPermission':
      case 'agentToolPermissionClear': {
        const entry = this.entryForAgent(id);
        if (!entry) return;
        core.tracker.status(
          entry.key,
          msg.type === 'agentToolPermission' ? 'waiting' : 'working',
          t,
        );
        this.sendAll(entry);
        return;
      }
      case 'agentToolStart':
      case 'agentToolDone':
      case 'agentToolsClear': {
        const entry = this.entryForAgent(id);
        if (!entry) return;
        this.applyToolEvent(entry, msg);
        this.sendAll(entry);
        // A Task call is also the sub-agent's own first activity line (its card was drawn
        // from this same event, just before).
        if (msg.type === 'agentToolStart' && typeof msg.toolId === 'string') {
          const subKey = this.byTool.get(toolRef(id, msg.toolId));
          const sub = subKey ? this.entries.get(subKey) : undefined;
          if (sub && typeof msg.status === 'string') {
            sub.tools.set(msg.toolId, msg.status);
            this.sendAll(sub);
          }
        }
        return;
      }
      case 'subagentToolStart':
      case 'subagentToolDone':
      case 'subagentClear':
      case 'subagentToolPermission': {
        const parentToolId = msg.parentToolId;
        if (typeof parentToolId !== 'string') return;
        const key = this.byTool.get(toolRef(id, parentToolId));
        const entry = key ? this.entries.get(key) : undefined;
        if (!key || !entry) return;
        if (msg.type === 'subagentToolPermission') core.tracker.status(key, 'waiting', t);
        else if (msg.type === 'subagentToolStart') core.tracker.status(key, 'working', t);
        this.applyToolEvent(entry, msg);
        this.sendAll(entry);
        return;
      }
    }
  }

  private applyToolEvent(entry: Entry, msg: Record<string, unknown>): void {
    const toolId = typeof msg.toolId === 'string' ? msg.toolId : undefined;
    switch (msg.type) {
      case 'agentToolStart':
      case 'subagentToolStart':
        if (toolId !== undefined && typeof msg.status === 'string') {
          // Re-insert so the newest tool is always last.
          entry.tools.delete(toolId);
          entry.tools.set(toolId, msg.status);
        }
        this.core?.tracker.activity(entry.key, this.now());
        return;
      case 'agentToolDone':
      case 'subagentToolDone':
        if (toolId !== undefined) entry.tools.delete(toolId);
        return;
      case 'agentToolsClear':
        // Background sub-agents' spawn calls are re-sent right after, so a full clear is safe.
        entry.tools.clear();
        return;
      case 'subagentClear':
        entry.tools.clear();
        return;
    }
  }

  // ── Messages ──

  private entryForAgent(agentId: number): Entry | undefined {
    const key = this.byAgentId.get(agentId);
    return key ? this.entries.get(key) : undefined;
  }

  /** The card key an agent from either store works for. */
  private keyFor(agentId: number, agent: AgentState): string | undefined {
    const direct = this.byAgentId.get(agentId);
    if (direct) return direct;
    if (agent.leadAgentId !== undefined && agent.spawnToolUseId) {
      return this.byTool.get(toolRef(agent.leadAgentId, agent.spawnToolUseId));
    }
    return undefined;
  }

  private sendSelection(selection: PanelSelection): void {
    const key =
      selection.parentToolId !== undefined
        ? this.byTool.get(toolRef(selection.agentId, selection.parentToolId))
        : this.byAgentId.get(selection.agentId);
    const entry = key ? this.entries.get(key) : undefined;
    const held = entry?.identities.get(
      identityKey({ id: selection.agentId, parentToolId: selection.parentToolId }),
    );
    if (entry && held) this.send(entry, held.identity);
  }

  private sendAll(entry: Entry): void {
    for (const { identity } of entry.identities.values()) this.send(entry, identity);
  }

  private send(entry: Entry, identity: Identity): void {
    if (this.disposed) return;
    const msg = this.build(entry, identity);
    if (msg) this.mainStore?.broadcast(msg as unknown as Record<string, unknown>);
  }

  private build(entry: Entry, identity: Identity): AgentRoster | undefined {
    const core = this.core;
    if (!core) return undefined;
    const assignment = core.assigner.cardFor(entry.key);
    if (!assignment) return undefined;
    const card = assignment.card;
    const stats = card ? core.store.get(card.id) : ZERO_STATS;
    const snap = core.tracker.snapshot(entry.key);
    // A sub-agent's whole run is its one task; the tracker only follows top-level turns.
    const taskStartedAt = entry.isLead ? snap.taskStartedAt : entry.startedAt;
    const taskEndedAt = entry.isLead ? snap.taskEndedAt : null;
    let activity = '';
    for (const text of entry.tools.values()) activity = text;
    const msg: AgentRoster = {
      type: 'agentRoster',
      id: identity.id,
      temp: assignment.isTemp,
      isLead: assignment.isLead,
      card: card
        ? {
            id: card.id,
            name: card.name,
            role: card.role,
            department: card.department,
            favoriteFact: card.favoriteFact,
            spriteIndex: card.spriteIndex,
          }
        : null,
      level: levelInfo(stats.xp),
      stats: {
        workedSeconds: stats.workedSeconds,
        tasksCompleted: Math.round(stats.tasksCompleted),
        lifetimeTokens: Math.round(stats.lifetimeTokens),
      },
      now: {
        status: toStatus(snap.status),
        projectName: projectNameOf(this.mainStore?.get(entry.ownerId)),
        activity,
        taskStartedAt: taskStartedAt === null ? null : Math.round(taskStartedAt),
        taskEndedAt: taskEndedAt === null ? null : Math.round(taskEndedAt),
        taskTokens: Math.round(snap.taskTokens),
      },
    };
    if (identity.parentToolId !== undefined) msg.parentToolId = identity.parentToolId;
    return msg;
  }

  /** The roster must never break the agents it describes. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`[Pixel Agents] Roster error: ${String(err)}`);
    }
  }
}

function toStatus(status: TrackedStatus): RosterStatus {
  return status;
}

/** The roster for a real run. Lazy: nothing is opened until the first agent gets a card. */
export function createRoster(opts: RosterOptions = {}): Roster {
  return new Roster(opts);
}
