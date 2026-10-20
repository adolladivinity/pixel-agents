import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRoster } from '../../core/src/messages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { createRoster, defaultRosterPath, type Roster } from '../src/roster/index.js';
import { RosterStore } from '../src/roster/rosterStore.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/**
 * End-to-end wiring of the roster into the runtime: hook events, transcript lines, store
 * broadcasts and agent removal go in; stats on the card and `agentRoster` messages come out.
 * Every test uses a roster file in its own temp dir and an injected clock.
 */
describe('roster wiring', () => {
  let tmpDir: string;
  let rosterFile: string;
  let clock: number;
  let store: AgentStateStore;
  let roster: Roster;
  let runtime: AgentRuntime;
  let sent: AgentRoster[];

  const T0 = 1_800_000_000_000;

  function leadAgent(id = 1, overrides: Partial<AgentState> = {}): AgentState {
    return createAgentState({
      id,
      sessionId: `sess-${id}`,
      isExternal: true,
      projectDir: tmpDir,
      jsonlFile: path.join(tmpDir, `sess-${id}.jsonl`),
      directoryName: 'my-proj',
      ...overrides,
    });
  }

  function addLead(id = 1, overrides: Partial<AgentState> = {}): AgentState {
    const agent = leadAgent(id, overrides);
    store.set(id, agent);
    runtime.registerAgent(agent.sessionId, id);
    return agent;
  }

  function hook(name: string, sessionId = 'sess-1', extra: Record<string, unknown> = {}): void {
    runtime.handleHookEvent('claude', {
      hook_event_name: name,
      session_id: sessionId,
      ...extra,
    });
  }

  function line(agentId: number, record: unknown, target: AgentStateStore = store): void {
    processTranscriptLine(
      agentId,
      JSON.stringify(record),
      target,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
  }

  const userPrompt = { type: 'user', message: { role: 'user', content: 'do the thing' } };
  const turnDuration = { type: 'system', subtype: 'turn_duration', durationMs: 5000 };

  function assistant(messageId: string, usage: Record<string, number>, extra = {}) {
    return {
      type: 'assistant',
      ...extra,
      message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage },
    };
  }

  /** Current roster view of one holder, built fresh (not the last message sent). */
  function view(id: number, parentToolId?: string): AgentRoster {
    const found = roster
      .snapshotMessages()
      .find((m) => m.id === id && m.parentToolId === parentToolId);
    if (!found) throw new Error(`no roster entry for ${id} ${parentToolId ?? ''}`);
    return found;
  }

  /** What a fresh process would read from disk. */
  function onDisk(cardId: string) {
    return new RosterStore({
      filePath: rosterFile,
      processId: 'reader',
      now: () => clock,
      log: () => {},
    }).get(cardId);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-roster-wiring-'));
    rosterFile = path.join(tmpDir, 'roster.json');
    clock = T0;
    store = new AgentStateStore();
    roster = createRoster({
      filePath: rosterFile,
      processId: 'wiring-test',
      timers: false,
      now: () => clock,
      log: () => {},
    });
    runtime = new AgentRuntime(store, claudeProvider, { roster });
    sent = [];
    store.on('broadcast', (m) => {
      if (m.type === 'agentRoster') sent.push(m as unknown as AgentRoster);
    });
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('agentRoster is sent on assignment with temp=false, isLead=true for a top-level session', async () => {
    addLead();
    await Promise.resolve(); // the send is deferred past the store event
    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.id).toBe(1);
    expect(msg.parentToolId).toBeUndefined();
    expect(msg.temp).toBe(false);
    expect(msg.isLead).toBe(true);
    expect(msg.card?.name).toBeTruthy();
    expect(msg.card?.id).toBe(store.get(1)?.cardId);
    expect(msg.level).toEqual({ level: 1, xpIntoLevel: 0, xpToNext: 100 });
    expect(msg.stats).toEqual({ workedSeconds: 0, tasksCompleted: 0, lifetimeTokens: 0 });
    expect(msg.now).toEqual({
      status: 'idle',
      projectName: 'my-proj',
      activity: '',
      taskStartedAt: null,
      taskEndedAt: null,
      taskTokens: 0,
    });
  });

  it('a Temp (pool exhausted) is sent with temp=true, no card and no stats', async () => {
    store = new AgentStateStore();
    roster = createRoster({
      filePath: rosterFile,
      processId: 'temp-test',
      timers: false,
      cards: [],
      now: () => clock,
      log: () => {},
    });
    runtime.dispose();
    runtime = new AgentRuntime(store, claudeProvider, { roster });
    sent = [];
    store.on('broadcast', (m) => {
      if (m.type === 'agentRoster') sent.push(m as unknown as AgentRoster);
    });
    addLead();
    await Promise.resolve();
    expect(sent[0]).toMatchObject({ id: 1, temp: true, isLead: true, card: null });
    expect(sent[0].level.level).toBe(1);
  });

  it("hook UserPromptSubmit then Stop counts one task on the agent's card", () => {
    addLead();
    const cardId = store.get(1)!.cardId!;
    hook('UserPromptSubmit');
    clock += 5_000;
    hook('Stop');
    const msg = view(1);
    expect(msg.stats.tasksCompleted).toBe(1);
    expect(msg.now.taskStartedAt).toBe(T0);
    expect(msg.now.taskEndedAt).toBe(T0 + 5_000);
    expect(runtime.getAssignment(1)?.card?.id).toBe(cardId);
    // A second Stop with no prompt finished nothing.
    hook('Stop');
    expect(view(1).stats.tasksCompleted).toBe(1);
  });

  it('hooks-off mode: transcript turn end counts one task', () => {
    addLead();
    line(1, userPrompt);
    clock += 4_000;
    line(1, turnDuration);
    const msg = view(1);
    expect(msg.stats.tasksCompleted).toBe(1);
    expect(msg.now.taskStartedAt).toBe(T0);
    expect(msg.now.taskEndedAt).toBe(T0 + 4_000);
    expect(msg.now.status).toBe('idle');
    // The same turn-end seen again is not a second task.
    line(1, turnDuration);
    expect(view(1).stats.tasksCompleted).toBe(1);
  });

  it('hooks mode: the transcript starts the turn but only the Stop hook counts it', () => {
    addLead();
    hook('PostToolUse'); // hooks are now delivering for this agent
    line(1, userPrompt);
    clock += 3_000;
    line(1, turnDuration); // would count in hooks-off mode; must not here
    expect(view(1).stats.tasksCompleted).toBe(0);
    hook('Stop');
    expect(view(1).stats.tasksCompleted).toBe(1);
    line(1, turnDuration);
    expect(view(1).stats.tasksCompleted).toBe(1);
  });

  it('a transcript prompt does not restart a turn a hook prompt already opened', () => {
    addLead();
    hook('UserPromptSubmit');
    clock += 1_000;
    line(1, userPrompt);
    hook('Stop');
    expect(view(1).now.taskStartedAt).toBe(T0);
    expect(view(1).stats.tasksCompleted).toBe(1);
  });

  it('assistant JSONL lines add tokens to the lead card, counting each message id once', () => {
    addLead();
    line(1, userPrompt);
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      output_tokens: 20,
      cache_read_input_tokens: 9_999,
    };
    line(1, assistant('msg_a', usage));
    line(1, assistant('msg_a', usage)); // streamed rewrite of the same message
    line(1, assistant('msg_b', { input_tokens: 1, output_tokens: 2 }));
    const msg = view(1);
    expect(msg.stats.lifetimeTokens).toBe(38);
    expect(msg.now.taskTokens).toBe(38);
  });

  it("assistant JSONL lines add tokens to the subagent's own card, not the parent's", () => {
    addLead();
    const shadow = runtime.subagentWatch.store;
    shadow.set(
      1_000_000,
      createAgentState({
        id: 1_000_000,
        sessionId: 'sess-1',
        isExternal: true,
        projectDir: tmpDir,
        jsonlFile: path.join(tmpDir, 'sub.jsonl'),
        leadAgentId: 1,
        spawnToolUseId: 'toolu_bg',
      }),
    );
    line(1_000_000, assistant('msg_sub', { input_tokens: 100, output_tokens: 50 }), shadow);
    line(1, assistant('msg_parent', { input_tokens: 7, output_tokens: 3 }));

    const parent = view(1);
    const sub = view(1, 'toolu_bg');
    expect(sub.isLead).toBe(false);
    expect(sub.stats.lifetimeTokens).toBe(150);
    expect(parent.stats.lifetimeTokens).toBe(10);
    expect(sub.card?.id).not.toBe(parent.card?.id);
  });

  it('counts a sub-agent message once when it shows up in both the agent_progress and sidecar streams', () => {
    addLead();
    const shadow = runtime.subagentWatch.store;
    shadow.set(
      1_000_000,
      createAgentState({
        id: 1_000_000,
        sessionId: 'sess-1',
        isExternal: true,
        projectDir: tmpDir,
        jsonlFile: path.join(tmpDir, 'sub.jsonl'),
        leadAgentId: 1,
        spawnToolUseId: 'toolu_both',
      }),
    );
    // The parser only follows progress records of a live sub-agent spawn tool call.
    store.get(1)!.activeToolNames.set('toolu_both', 'Task');
    const same = assistant('msg_shared', { input_tokens: 100, output_tokens: 50 });
    const other = assistant('msg_other', { input_tokens: 8, output_tokens: 2 });
    // The sidecar stream (shadow store) and the embedded stream (progress record on the lead).
    line(1_000_000, same, shadow);
    line(1, {
      type: 'progress',
      parentToolUseID: 'toolu_both',
      data: { type: 'agent_progress', message: same },
    });
    expect(view(1, 'toolu_both').stats.lifetimeTokens).toBe(150);
    // A different message id in either stream still counts.
    line(1_000_000, other, shadow);
    expect(view(1, 'toolu_both').stats.lifetimeTokens).toBe(160);
    expect(view(1).stats.lifetimeTokens).toBe(0);
  });

  it('sidechain records inlined in a lead transcript are not credited to the lead', () => {
    addLead();
    line(1, assistant('msg_main', { input_tokens: 4, output_tokens: 1 }));
    line(
      1,
      assistant('msg_side', { input_tokens: 500, output_tokens: 500 }, { isSidechain: true }),
    );
    expect(view(1).stats.lifetimeTokens).toBe(5);
  });

  it('agent removal flushes and releases the card', () => {
    addLead();
    const cardId = store.get(1)!.cardId!;
    hook('UserPromptSubmit');
    clock += 2_000;
    hook('Stop');
    line(1, assistant('msg_a', { input_tokens: 40, output_tokens: 2 }));
    // Nothing has been flushed yet (the 10 s timer is off in this test).
    expect(onDisk(cardId).tasksCompleted).toBe(0);

    runtime.removeAgent(1);

    const saved = onDisk(cardId);
    expect(saved.tasksCompleted).toBe(1);
    expect(saved.lifetimeTokens).toBe(42);
    const other = new RosterStore({ filePath: rosterFile, processId: 'other', log: () => {} });
    expect(other.tryClaim(cardId, 'x')).toBe(true); // the claim is gone
  });

  it('banks working time and XP on the 1 s tick, only while working', () => {
    addLead();
    const cardId = store.get(1)!.cardId!;
    hook('PreToolUse', 'sess-1', { tool_name: 'Read', tool_input: { file_path: '/x/a.ts' } });
    clock += 10_000;
    roster.tick();
    let msg = view(1);
    expect(msg.stats.workedSeconds).toBeCloseTo(10, 5);
    expect(msg.level.xpIntoLevel).toBeCloseTo(2, 5); // 0.2 XP per working second
    expect(msg.now.status).toBe('working');
    hook('Stop');
    clock += 30_000;
    roster.tick();
    msg = view(1);
    expect(msg.stats.workedSeconds).toBeCloseTo(10, 5);
    expect(msg.now.status).toBe('idle');
    runtime.removeAgent(1);
    expect(onDisk(cardId).workedSeconds).toBeCloseTo(10, 5);
  });

  it('sends agentRoster on a status or tool change, with the tool text as activity', () => {
    addLead();
    sent.length = 0;
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    store.broadcast({
      type: 'agentToolStart',
      id: 1,
      toolId: 'toolu_r',
      status: 'Reading a.ts',
      toolName: 'Read',
    });
    const last = sent[sent.length - 1];
    expect(last.now.status).toBe('working');
    expect(last.now.activity).toBe('Reading a.ts');
    store.broadcast({ type: 'agentToolDone', id: 1, toolId: 'toolu_r' });
    expect(sent[sent.length - 1].now.activity).toBe('');
    store.broadcast({ type: 'agentToolPermission', id: 1 });
    expect(sent[sent.length - 1].now.status).toBe('waiting');
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: true });
    expect(sent[sent.length - 1].now.status).toBe('waiting');
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: false });
    expect(sent[sent.length - 1].now.status).toBe('idle');
  });

  describe('Task-tool sub-agents', () => {
    function startTask(toolId = 'toolu_task') {
      store.broadcast({
        type: 'agentToolStart',
        id: 1,
        toolId,
        status: 'Subtask: research',
        toolName: 'Task',
      });
    }

    it('are addressed by the parent id plus the spawning tool id', async () => {
      addLead();
      startTask();
      await Promise.resolve();
      const sub = sent.find((m) => m.parentToolId === 'toolu_task');
      expect(sub).toBeDefined();
      expect(sub?.id).toBe(1);
      expect(sub?.isLead).toBe(false);
      expect(sub?.temp).toBe(false);
      expect(sub?.now.status).toBe('working');
      expect(sub?.now.taskStartedAt).toBe(T0);
      expect(sub?.now.activity).toBe('Subtask: research');
    });

    it('show their own tool text and count one task when the run lasted 10 s or more', () => {
      addLead();
      startTask();
      store.broadcast({
        type: 'subagentToolStart',
        id: 1,
        parentToolId: 'toolu_task',
        toolId: 'toolu_inner',
        status: 'Searching the web',
      });
      expect(view(1, 'toolu_task').now.activity).toBe('Searching the web');
      // The parent still shows its own Task call.
      expect(view(1).now.activity).toBe('Subtask: research');
      const subCard = view(1, 'toolu_task').card!.id;
      clock += 12_000;
      store.broadcast({ type: 'agentToolDone', id: 1, toolId: 'toolu_task' });
      expect(onDisk(subCard).tasksCompleted).toBe(1);
      expect(onDisk(subCard).workedSeconds).toBeCloseTo(12, 5);
      expect(roster.snapshotMessages().some((m) => m.parentToolId === 'toolu_task')).toBe(false);
    });

    it('stay addressable when their watched transcript is dropped before the tool call ends', () => {
      addLead();
      startTask('toolu_fg');
      const shadow = runtime.subagentWatch.store;
      shadow.set(
        1_000_001,
        createAgentState({
          id: 1_000_001,
          sessionId: 'sess-1',
          isExternal: true,
          projectDir: tmpDir,
          jsonlFile: path.join(tmpDir, 'fg.jsonl'),
          leadAgentId: 1,
          spawnToolUseId: 'toolu_fg',
        }),
      );
      // Same card for the tool call and its transcript.
      expect(roster.snapshotMessages().filter((m) => m.parentToolId === 'toolu_fg')).toHaveLength(
        1,
      );
      shadow.delete(1_000_001); // the foreground watch stops first
      expect(view(1, 'toolu_fg').isLead).toBe(false);
      store.broadcast({ type: 'agentToolDone', id: 1, toolId: 'toolu_fg' });
      expect(roster.snapshotMessages().some((m) => m.parentToolId === 'toolu_fg')).toBe(false);
    });

    it('earn no task when the run is shorter than 10 s', () => {
      addLead();
      startTask();
      const subCard = view(1, 'toolu_task').card!.id;
      clock += 4_000;
      store.broadcast({ type: 'agentToolDone', id: 1, toolId: 'toolu_task' });
      expect(onDisk(subCard).tasksCompleted).toBe(0);
    });

    it('a re-sent tool start (background spawns repeat every turn) does not leak after done', () => {
      addLead();
      startTask();
      startTask(); // same tool id again
      store.broadcast({ type: 'agentToolDone', id: 1, toolId: 'toolu_task' });
      const internals = roster as unknown as { byTool: Map<string, string> };
      expect(internals.byTool.size).toBe(0);
      expect(roster.snapshotMessages().some((m) => m.parentToolId === 'toolu_task')).toBe(false);
    });
  });

  describe('panel selection', () => {
    it('sends the selected agent once per tick and stops on null', () => {
      addLead();
      addLead(2);
      sent.length = 0;
      roster.setPanelSelection('client-a', { agentId: 2 });
      expect(sent.map((m) => m.id)).toEqual([2]); // immediately
      roster.tick();
      roster.tick();
      expect(sent.map((m) => m.id)).toEqual([2, 2, 2]);
      roster.setPanelSelection('client-a', null);
      roster.tick();
      expect(sent).toHaveLength(3);
    });

    it('serves two clients with different selections and drops a client that left', () => {
      addLead();
      addLead(2);
      roster.setPanelSelection('a', { agentId: 1 });
      roster.setPanelSelection('b', { agentId: 2 });
      sent.length = 0;
      roster.tick();
      expect(sent.map((m) => m.id).sort()).toEqual([1, 2]);
      roster.clearPanelSelection('a');
      sent.length = 0;
      roster.tick();
      expect(sent.map((m) => m.id)).toEqual([2]);
    });

    it('sends nothing for an agent that is gone', () => {
      addLead();
      roster.setPanelSelection('a', { agentId: 1 });
      runtime.removeAgent(1);
      sent.length = 0;
      roster.tick();
      expect(sent).toHaveLength(0);
    });

    it('is set by the rosterPanelSelect client message, even for a read-only client', () => {
      addLead();
      sent.length = 0;
      const ctx = { store, runtime, cache: null, privileged: false, clientKey: 'ws-1' };
      handleClientMessage({ type: 'rosterPanelSelect', agentId: 1 }, () => {}, ctx);
      expect(sent.map((m) => m.id)).toEqual([1]);
      roster.tick();
      expect(sent).toHaveLength(2);
      handleClientMessage({ type: 'rosterPanelSelect', agentId: null }, () => {}, ctx);
      roster.tick();
      expect(sent).toHaveLength(2);
    });
  });

  it('replays the roster to a client that connects later', () => {
    addLead();
    addLead(2);
    expect(
      runtime
        .rosterMessages()
        .map((m) => m.id)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('dispose stops the timers, flushes and releases every claim', () => {
    addLead();
    const cardId = store.get(1)!.cardId!;
    hook('UserPromptSubmit');
    clock += 1_000;
    hook('Stop');
    runtime.dispose();
    expect(onDisk(cardId).tasksCompleted).toBe(1);
    const other = new RosterStore({ filePath: rosterFile, processId: 'other', log: () => {} });
    expect(other.tryClaim(cardId, 'x')).toBe(true);
  });

  it('keeps agents working on a corrupt roster file and never overwrites it', () => {
    runtime.dispose();
    fs.writeFileSync(rosterFile, '{ not json');
    store = new AgentStateStore();
    const warnings: string[] = [];
    roster = createRoster({
      filePath: rosterFile,
      processId: 'corrupt-test',
      timers: false,
      now: () => clock,
      log: (m) => warnings.push(m),
    });
    runtime = new AgentRuntime(store, claudeProvider, { roster });
    addLead();
    hook('UserPromptSubmit');
    clock += 1_000;
    hook('Stop');
    expect(view(1).stats.tasksCompleted).toBe(1); // counted in memory
    runtime.removeAgent(1);
    expect(fs.readFileSync(rosterFile, 'utf-8')).toBe('{ not json');
    expect(fs.readdirSync(tmpDir).some((f) => f.startsWith('roster.json.corrupt-'))).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('defaults to ~/.pixel-agents/roster.json', () => {
    expect(defaultRosterPath()).toBe(path.join(os.homedir(), '.pixel-agents', 'roster.json'));
  });
});
