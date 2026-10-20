import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { CardAssigner } from '../src/roster/cardAssigner.js';
import { RosterStore } from '../src/roster/rosterStore.js';
import { loadSeed } from '../src/roster/seed.js';
import type { AgentState, PersistedAgent } from '../src/types.js';

/**
 * D5 gate (tier-3 multi-server hook fan-out plan): the hook script now
 * broadcasts every event to every live server (server/src/providers/hook/
 * claude/hooks/claude-hook.ts), so a server must never adopt a session it
 * doesn't own just because it received the event. HookEventHandler's own
 * isTrackedSession only gates debug logging (hookEventHandler.ts:173-174);
 * the actual gate is one hop downstream, in AgentRuntime's
 * onExternalSessionDetected callback (agentRuntime.ts:96-101), which drops
 * the session unless its project dir was scanned by this instance
 * (isTrackedProjectDir) or watchAllSessions is on. These tests exercise
 * that real callback end-to-end via handleHookEvent, not a mock.
 */
describe('AgentRuntime -- D5 foreign-session gate', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => {
    // Clears the project-scan interval and any polling timer from adoption.
    runtime?.dispose();
  });

  /** A directory guaranteed untracked by any other test in this file or
   *  process (isTrackedProjectDir's backing Set is module-level and only
   *  ever grows -- see fileWatcher.ts -- so uniqueness is what keeps tests
   *  from leaking into each other). */
  function untrackedDir(): string {
    return path.join(os.tmpdir(), `pxl-d5-test-${crypto.randomUUID()}`);
  }

  function fireSessionStartThenStop(sessionId: string, cwd: string): void {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd,
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: sessionId,
    });
  }

  it('drops a foreign session (unowned dir, watchAllSessions off): no agent created', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    // watchAllSessions defaults to false; this dir was never scanned/owned
    // by this instance -- exactly the "other server's session" scenario
    // fan-out introduces.
    fireSessionStartThenStop('d5-foreign-off', untrackedDir());
    expect(store.size).toBe(0);
  });

  it('adopts a foreign session when watchAllSessions is on', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    fireSessionStartThenStop('d5-foreign-on', untrackedDir());
    expect(store.size).toBe(1);
  });

  it('adopts a session under a project dir this instance has scanned, even with watchAllSessions off', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    const dir = untrackedDir();
    runtime.startProjectScan(dir); // marks `dir` as owned/tracked
    fireSessionStartThenStop('d5-tracked-dir', dir);
    expect(store.size).toBe(1);
  });
});

/**
 * Roster wiring: a CardAssigner is drawn when an agent joins the store, released when it
 * leaves, persisted with the agent, and re-attached on restore. Every test builds its own
 * RosterStore in a temp dir; nothing here touches the real ~/.pixel-agents.
 */
describe('AgentRuntime -- roster card assignment', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let runtime: AgentRuntime | undefined;
  let rosterFile: string;

  function rosterStore(processId: string): RosterStore {
    return new RosterStore({ filePath: rosterFile, processId, log: () => {} });
  }

  function newAssigner(processId = 'test-proc'): CardAssigner {
    return new CardAssigner(loadSeed(), rosterStore(processId));
  }

  function adapter(initial: PersistedAgent[] = []): StateAdapter & { saved: PersistedAgent[][] } {
    let current = initial;
    const saved: PersistedAgent[][] = [];
    return {
      saved,
      loadAgents: () => current,
      saveAgents: (agents) => {
        current = agents;
        saved.push(agents);
      },
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
      setSetting: vi.fn<(key: string, value: unknown) => void>(),
    };
  }

  function agentState(id: number, overrides: Partial<AgentState> = {}): AgentState {
    return createAgentState({
      id,
      sessionId: `sess-${id}`,
      isExternal: true,
      projectDir: tmpDir,
      jsonlFile: jsonlPath,
      ...overrides,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-roster-rt-'));
    jsonlPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(jsonlPath, '');
    rosterFile = path.join(tmpDir, 'roster.json');
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('draws a card when an agent is added, and marks it as a lead', () => {
    const assigner = newAssigner();
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, { cardAssigner: assigner });
    store.set(1, agentState(1));
    const cardId = store.get(1)?.cardId;
    expect(cardId).toBeTruthy();
    expect(assigner.cardFor('sess-1')?.card?.id).toBe(cardId);
    expect(assigner.cardFor('sess-1')?.isLead).toBe(true);
    expect(runtime.getAssignment(1)?.card?.id).toBe(cardId);
  });

  it('does nothing when no roster is configured', () => {
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    store.set(1, agentState(1));
    expect(store.get(1)?.cardId).toBeUndefined();
    expect(runtime.getAssignment(1)).toBeUndefined();
  });

  it('builds a lazy assigner only when the first agent arrives', () => {
    const factory = vi.fn(() => newAssigner());
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, { cardAssigner: factory });
    expect(factory).not.toHaveBeenCalled();
    store.set(1, agentState(1));
    store.set(2, agentState(2));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(store.get(1)?.cardId).toBeTruthy();
  });

  it('never lets a failing roster break agent creation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, {
      cardAssigner: () => {
        throw new Error('bad seed');
      },
    });
    expect(() => store.set(1, agentState(1))).not.toThrow();
    expect(store.has(1)).toBe(true);
    expect(store.get(1)?.cardId).toBeUndefined();
    warn.mockRestore();
  });

  it('gives a Temp (no cardId) once the pool is exhausted', () => {
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, {
      cardAssigner: new CardAssigner([], rosterStore('p')),
    });
    store.set(1, agentState(1));
    expect(store.get(1)?.cardId).toBeUndefined();
    expect(runtime.getAssignment(1)?.isTemp).toBe(true);
  });

  it('persists cardId and re-attaches the same card on restore', () => {
    const adapterA = adapter();
    const storeA = new AgentStateStore();
    storeA.setAdapter(adapterA);
    runtime = new AgentRuntime(storeA, claudeProvider, { cardAssigner: newAssigner('window-1') });
    storeA.set(7, agentState(7, { sessionId: 'sess-reload' }));
    storeA.persist();
    const drawn = storeA.get(7)?.cardId;
    expect(drawn).toBeTruthy();
    const persisted = adapterA.saved[0];
    expect(persisted[0].cardId).toBe(drawn);

    // "Reload": the old window goes away, a new runtime restores from the persisted record.
    runtime.dispose();
    runtime = undefined;

    const storeB = new AgentStateStore();
    storeB.setAdapter(adapter(persisted));
    const assignerB = newAssigner('window-2');
    runtime = new AgentRuntime(storeB, claudeProvider, { cardAssigner: assignerB });
    runtime.restoreExternalAgents();
    expect(storeB.get(7)?.cardId).toBe(drawn);
    expect(assignerB.cardFor('sess-reload')?.card?.id).toBe(drawn);
  });

  it('draws a fresh card on restore when the persisted card left the seed', () => {
    const store = new AgentStateStore();
    store.setAdapter(
      adapter([
        {
          id: 3,
          sessionId: 'sess-gone',
          terminalName: '',
          isExternal: true,
          jsonlFile: jsonlPath,
          projectDir: tmpDir,
          cardId: 'card-that-was-removed',
        },
      ]),
    );
    runtime = new AgentRuntime(store, claudeProvider, { cardAssigner: newAssigner() });
    runtime.restoreExternalAgents();
    const cardId = store.get(3)?.cardId;
    expect(cardId).toBeTruthy();
    expect(cardId).not.toBe('card-that-was-removed');
  });

  it('releases the card when the agent is removed', () => {
    const assigner = newAssigner('mine');
    const release = vi.spyOn(assigner, 'release');
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, { cardAssigner: assigner });
    store.set(1, agentState(1));
    const cardId = store.get(1)!.cardId!;
    const other = rosterStore('other');
    expect(other.tryClaim(cardId, 'x')).toBe(false);

    runtime.removeAgent(1);

    expect(release).toHaveBeenCalledWith('sess-1');
    expect(other.tryClaim(cardId, 'x')).toBe(true);
    expect(runtime.getAssignment(1)).toBeUndefined();
  });

  it('releases when an agent is deleted straight from the store (VS Code terminal close)', () => {
    const assigner = newAssigner();
    const release = vi.spyOn(assigner, 'release');
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, { cardAssigner: assigner });
    store.set(1, agentState(1));
    store.delete(1);
    expect(release).toHaveBeenCalledWith('sess-1');
  });

  it('gives a teammate that shares its lead session its own card, flagged as not a lead', () => {
    const assigner = newAssigner();
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, { cardAssigner: assigner });
    store.set(1, agentState(1, { sessionId: 'shared' }));
    store.set(2, agentState(2, { sessionId: 'shared', leadAgentId: 1, agentName: 'helper' }));
    const lead = store.get(1)!.cardId;
    const mate = store.get(2)!.cardId;
    expect(lead).toBeTruthy();
    expect(mate).toBeTruthy();
    expect(mate).not.toBe(lead);
    expect(runtime.getAssignment(1)?.isLead).toBe(true);
    expect(runtime.getAssignment(2)?.isLead).toBe(false);

    runtime.removeAgent(2);
    expect(runtime.getAssignment(1)?.card?.id).toBe(lead);
  });

  it('gives watched background sub-agents (shadow store) their own cards and releases them', () => {
    const assigner = newAssigner();
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, { cardAssigner: assigner });
    store.set(1, agentState(1, { sessionId: 'lead-sess' }));
    const shadow = runtime.subagentWatch.store;
    const sub = agentState(1_000_000, {
      sessionId: 'lead-sess',
      leadAgentId: 1,
      spawnToolUseId: 'toolu_1',
    });
    shadow.set(1_000_000, sub);
    expect(sub.cardId).toBeTruthy();
    expect(sub.cardId).not.toBe(store.get(1)?.cardId);
    expect(runtime.getAssignment(1_000_000)?.isLead).toBe(false);
    shadow.delete(1_000_000);
    expect(runtime.getAssignment(1_000_000)).toBeUndefined();
    expect(runtime.getAssignment(1)).toBeDefined();
  });

  it('dedupes by session id: hooks and the scanner both adding a session share one card', () => {
    const assigner = newAssigner();
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, { cardAssigner: assigner });
    store.set(1, agentState(1, { sessionId: 'dup' }));
    store.set(2, agentState(2, { sessionId: 'dup' }));
    expect(store.get(2)?.cardId).toBe(store.get(1)?.cardId);

    // The shared card stays held until the last agent for that session goes.
    runtime.removeAgent(1);
    expect(runtime.getAssignment(2)?.card?.id).toBe(store.get(2)?.cardId);
    runtime.removeAgent(2);
    expect(assigner.cardFor('dup')).toBeUndefined();
  });

  it('releases every card on dispose', () => {
    const assigner = newAssigner();
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, { cardAssigner: assigner });
    store.set(1, agentState(1));
    runtime.dispose();
    runtime = undefined;
    expect(assigner.cardFor('sess-1')).toBeUndefined();
  });
});
