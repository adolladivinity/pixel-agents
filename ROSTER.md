# ROSTER.md — working notes for the personal roster fork

Branch `roster` = upstream PR #393 (`wevex1/pixel-agents` `feat/taskboard`, the task board and
selection-bound panel) rebased onto `pixel-agents-hq/pixel-agents` `main`
(base commit recorded in the Task 1 report; check with `git merge-base upstream/main roster`).
Remotes: `origin` = `adolladivinity/pixel-agents` (push here only), `upstream` = pixel-agents-hq,
`pr393` = wevex1. Never push to `upstream` or `pr393`.

Later roster tasks rely on this file instead of re-exploring the repo.

## Setup (Windows 10, Git Bash, Node 24; upstream needs Node 22.13+)

- `npm ci` at the repo root (installs all workspaces; also installs husky hooks).
- Husky `pre-commit` needs `gitleaks` on PATH (`winget install Gitleaks.Gitleaks`; open a new
  shell, or add `$LOCALAPPDATA/Microsoft/WinGet/Packages/Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe`
  to PATH) and then runs lint-staged (prettier). `pre-push` runs `npm run check-types`,
  `npm run asyncapi:generate`, `npm run e2e:inventory`, and fails if `core/src/messages.ts` or
  `e2e/README.md` drift: regenerate and commit them.
- After editing `core/asyncapi.yaml` run `npm run asyncapi:generate` (writes `core/src/messages.ts`; never hand-edit).
- After adding/removing e2e tests run `npm run e2e:inventory` (rewrites the inventory in `e2e/README.md`).

## Test commands

IMPORTANT, protect the real home: server tests touch `~/.pixel-agents`. Upstream's tests set
`process.env.HOME`, which Windows `os.homedir()` ignores, so before the fix in this branch
(`server/__tests__/windowsHomeSetup.ts`, wired in `server/vitest.config.ts`) they wrote into the real
`C:\Users\thoma\.pixel-agents\config.json`. The shim now mirrors HOME into USERPROFILE. As a second
guard, run server tests with a throwaway profile:

```bash
mkdir -p /tmp/pa/home
# all server tests (713 pass, 25 skipped, 0 fail on this branch)
cd server && USERPROFILE="$(cygpath -w /tmp/pa/home)" HOME="" npx vitest run
# one server file
cd server && USERPROFILE="$(cygpath -w /tmp/pa/home)" HOME="" npx vitest run __tests__/hookEventHandler.test.ts
```

Webview unit tests (vitest, node environment, includes only `webview-ui/test/*.test.ts`, flat layout):

```bash
cd webview-ui && npm test                          # all (204 pass)
cd webview-ui && npx vitest run test/cardBar.test.ts   # one file
```

Everything unit-level from the root: `npm test` (= webview + server + `test:package-contract`).
Root-level `npm test` does NOT isolate the home dir; prefer the two commands above for server tests.

Other checks: `npm run check-types` (tsc root + server tests), `npm run lint`
(one pre-existing react-hooks warning in `App.tsx`, upstream's), `npm run format:check`.
Build for e2e: `node esbuild.js && npm run build:webview` (or `npm run compile`, which also runs
asyncapi:generate, check-types, lint).

e2e (Playwright; first run downloads VS Code 1.142 into `.vscode-test/` and needs
`npx playwright install chromium` for the standalone specs; each test uses an isolated temp HOME):

```bash
npm run e2e                                  # full suite, 148 tests, 1 worker, slow (see results below)
npm run e2e -- --grep "@area:tasks"          # filter by area tag
npm run e2e -- e2e/tests/standalone/taskboard.spec.ts   # one file
```

Last full run on this branch (Windows 10, VS Code 1.142.0, Node 24): **134 passed, 14 skipped, 0 failed, 0 flaky
(31.5 min)**. All 14 skips are upstream's own `test.skip(process.platform === 'win32', ...)` guards (PTY spawn of
the `.cmd` mock shim is untested on Windows: 3 in `standalone/launch-drawer.spec.ts`, 7 in `standalone/mobile.spec.ts`,
3 in `standalone/terminal.spec.ts`; plus the chmod-based test in `claude/hooks-on/consent.spec.ts`), so upstream
`main` skips the same ones on Windows. The three #393 task board specs all run and pass. The Playwright
`monitor terminal failed to open (cosmetic)` line in the log is harmless.

## Where things live (all paths relative to repo root)

### #393 selection panel (the "task board")

- Component: `webview-ui/src/components/TaskBoard.tsx`. Props: `agentTasks: Record<number, AgentTask[]>`,
  `selectedAgent: number | null`, `onSelectAgent(id)`, `belowTooltip`. Docks top-right of the office,
  shows only the SELECTED agent's task list (tab strip along the top selects an agent). No selection falls
  back to the first board. It renders nothing while no agent has published a list, so a roster panel
  must either extend this component or live beside it (Task 9 should extend it).
- Mounted in `webview-ui/src/App.tsx` (`<TaskBoard ...>`, hidden in layout edit mode; `isTaskBoardOpen`
  state, toggled by the `Tasks` button in `components/BottomToolbar.tsx`, props `isTaskBoardOpen`,
  `onToggleTaskBoard`, `hasTasks`).
- Selection source of truth: React state `selectedAgent` (number | null) from
  `webview-ui/src/hooks/useExtensionMessages.ts` (`setSelectedAgent` is exposed), mirrored with the
  imperative `OfficeState.selectedAgentId`. Canvas click: `office/components/OfficeCanvas.tsx`
  (`performTap`, calls the new `onAgentSelectionChange(id|null)` prop). Panel click:
  `App.tsx handleSelectAgentFromPanel` sets both halves and sends `focusAgent`. The VS Code adapter also sends
  `agentSelected` (`adapters/vscode/PixelAgentsViewProvider.ts` ~l.1012) when a terminal is focused. Test hook `selectionSync` in `testHooks.ts`.
- Panel data: `agentTasks` messages (`core/asyncapi.yaml` -> `core/src/messages.ts`), produced by
  `server/src/hookEventHandler.ts` (~lines 490-500, `agents.broadcast({type:'agentTasks',...})`) from
  Claude TodoWrite via `server/src/providers/hook/claude/claude.ts`; resent to new clients by
  `server/src/agentActivityResend.ts`. Webview handler: `useExtensionMessages.ts` (`msg.type === 'agentTasks'`).
- Office-side errand (agents walk to a board): `webview-ui/src/office/engine/officeState.ts`,
  `office/engine/characters.ts`; test `webview-ui/test/taskBoardErrand.test.ts`.
- e2e: `e2e/tests/standalone/taskboard.spec.ts`, `e2e/tests/claude/hooks-on/taskboard.spec.ts`,
  `e2e/tests/claude/hooks-on/taskboard-selection.spec.ts`, helpers in `e2e/helpers/office.ts`.

### Sprite and palette assignment (new agent)

- Server picks palette + hue: `server/src/paletteAssigner.ts` `assignPaletteIfNeeded(agent, store)`
  (no-op if `agent.palette` already set; uses `core/src/paletteUtils.ts pickDiversePalette`;
  `setPaletteCount` is set after assets load, bundled sprites are `webview-ui/public/assets/characters/char_0..5.png`,
  external asset dirs may add more `char_N.png`, loader `server/src/assetLoader.ts`).
- Callers (every place an agent is created): `server/src/agentRuntime.ts` (restore, ~l.520),
  `server/src/fileWatcher.ts` (external adopt / scan, ~l.518, 728, 867, 1085, 1151),
  `server/src/terminal/standaloneAgentLauncher.ts` (~l.127), `adapters/vscode/agentManager.ts` (~l.120, 378).
- Palette/hue are persisted on `AgentState` (`server/src/types.ts`) and `PersistedAgent` (`core/src/adapter.ts`)
  and sent to the webview in `agentCreated` / `existingAgents` (`palette`, `hueShift`).
- Webview draws: `OfficeState.addAgent(id, palette, hueShift, seatId, skipSpawnEffect, directoryName)` in
  `webview-ui/src/office/engine/officeState.ts`; face icon `webview-ui/src/components/CharacterMugShot.tsx`
  (used by `AgentCard.tsx`).

### Agent lifecycle (create, remove, restore)

- `server/src/agentStateStore.ts`: `AgentStateStore` single source of truth. `set()` emits
  `agentAdded`, `delete()` emits `agentRemoved`, also `agentUpdated`, `broadcast(message)`;
  `persist()` / `loadPersistedAgents()` go through the `StateAdapter`.
- `server/src/agentState.ts` `createAgentState(init)` builds every `AgentState`.
- `server/src/agentRuntime.ts`: `removeAgent(id)` (~l.308, calls `store.delete`), `restoreExternalAgents()`
  (~l.477, standalone restore from persisted state), stale cleanup, hook-adopt path (~l.202 calls
  `adoptExternalSessionFromHook` in `fileWatcher.ts`).
- Create paths: `fileWatcher.ts` (adoptExternalSession, scans), `terminal/standaloneAgentLauncher.ts`
  (standalone terminal agents), `adapters/vscode/agentManager.ts` (`launchNewTerminal`, `restoreAgents` ~l.298),
  teammates in `fileWatcher.ts`, hook confirmation in `sessionRouter.ts`.
- Events become webview messages in `server/src/httpServer.ts` (~l.224-247, standalone, `agentCreated` /
  `agentClosed`) and `adapters/vscode/PixelAgentsViewProvider.ts` (~l.139-155, VS Code).

### Hook events

- Raw event -> normalized `AgentEvent`: `server/src/providers/hook/claude/claude.ts` `normalizeHookEvent`
  (~l.162); event names in `providers/hook/claude/constants.ts`; the hook script itself is
  `providers/hook/claude/hooks/claude-hook.ts` (do not add work there).
- Dispatch: `server/src/hookEventHandler.ts` `handleEvent` (~l.132) with a switch over kinds
  (`sessionEnd`, `toolStart`, `toolEnd`, `subagentStart`, `subagentEnd`, `permissionRequest`, `turnEnd`,
  `subagentTurnEnd`, `progress`, ...); `registerAgent(sessionId, agentId)` binds sessions; routing/buffering in
  `sessionRouter.ts`; HTTP entry `POST /api/hooks/:providerId` in `httpServer.ts`.

### Transcript (JSONL) lines

- Reading: `server/src/fileWatcher.ts` `readNewLines` (~l.203): reads appended bytes, keeps a per-agent
  `agent.lineBuffer` so a partial last line is held until complete (relevant to Task 6), then calls
  `processTranscriptLine` per complete line (~l.245). Polling runs in hooks mode and heuristic mode.
- Parsing: `server/src/transcriptParser.ts` `processTranscriptLine` (~l.93); `updateContextUsage`
  (called ~l.135) already reads message `usage` for the context gauge; assistant/tool_use/tool_result handling below it.

### Subagents

- Unnamed background spawns: `server/src/subagentWatch.ts` `SubagentWatch` (transcripts under
  `<projectDir>/<leadSessionId>/subagents/`, driven in a shadow `AgentStateStore` with ids from 1_000_000, re-emitted
  on the main store as `subagentToolStart` etc.), created in `agentRuntime.ts` (~l.96).
- Named teammates become real agents (`fileWatcher.ts`, `claudeTeamProvider.ts`, `teamUtils.ts`).
- Hook-driven sub-agent start/end: `hookEventHandler.ts` (`subagentStart` / `subagentEnd`).
- Webview side: `useExtensionMessages.ts` `subagentToolStart` / `subagentToolDone` / `subagentClear` handlers.

### Webview receives server messages

- `webview-ui/src/hooks/useExtensionMessages.ts`: one `useEffect` message handler (`msg.type === ...` chain:
  `agentCreated` ~l.365, `agentClosed` ~l.411, `existingAgents` ~l.430, `agentStatus`, `agentTasks`, ...);
  returns state (`selectedAgent`, `agentTools`, `agentStatuses`, `agentTasks`, ...) consumed by `App.tsx`.
  Webview sends via `transport.send(...)` (`webview-ui/src/transport/`). Message types are defined in
  `core/asyncapi.yaml` and generated into `core/src/messages.ts`.

## Rebase notes (for the record)

PR #393 conflicted with upstream's directory launch surface, mobile shell, and terminal drawer refactors in
`App.tsx`, `BottomToolbar.tsx`, `useExtensionMessages.ts`, `OfficeCanvas.tsx`, and the generated e2e inventory.
Resolution kept both sides (upstream's `directories`/terminal props and #393's Tasks toggle; `omitKey` for
`agentTasks` cleanup on `agentClosed`; `onAgentSelectionChange` also fired on the mobile first-tap path).
