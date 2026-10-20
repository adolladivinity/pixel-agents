import type { AgentEvent } from '../../../core/src/provider.js';
import type { AgentState } from '../types.js';

/**
 * What the transcript reader and the hook handler tell the roster. A narrow interface so those
 * modules never import the roster itself, and tests can fake it. Every method must be cheap
 * and must not throw: it runs inside the line reader and the hook dispatch.
 *
 * `agentId` is the id in whichever store the agent lives in: the main store, or the shadow
 * store of watched background sub-agents (ids from 1_000_000).
 */
export interface RosterSink {
  /** A parsed transcript record of an agent: counts tokens and keeps the agent "active". */
  transcriptRecord(agentId: number, agent: AgentState, record: unknown): void;
  /** A record of a sub-agent embedded in its parent's transcript (agent_progress). */
  subagentRecord(
    parentAgentId: number,
    parentAgent: AgentState,
    parentToolId: string,
    record: unknown,
  ): void;
  /** The transcript shows a new user prompt (a turn is starting). */
  transcriptPrompt(agentId: number, agent: AgentState): void;
  /** A hook event was delivered to the agent. */
  hookEvent(agentId: number, agent: AgentState, kind: AgentEvent['kind']): void;
}
