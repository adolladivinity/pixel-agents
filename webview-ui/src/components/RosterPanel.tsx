import { useEffect, useState } from 'react';

import type { AgentRoster } from '../../../core/src/messages.js';
import { spriteForCard, spriteForTemp } from '../office/sprites/cardSprite.js';
import { getLoadedCharacterCount } from '../office/sprites/spriteData.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import {
  formatCount,
  formatDuration,
  formatHours,
  formatStatus,
  formatTokens,
  formatXpLine,
  taskElapsedMs,
  xpFraction,
} from './rosterFormat.js';

/** How the character looks in the office right now: the face icon's fallback
 *  when the card's own sprite is not loaded, and a temp's only look. */
export interface RosterAppearance {
  palette: number;
  hueShift: number;
}

interface RosterPanelProps {
  /** The roster record for the panel's agent, or null while none has arrived
   *  (or the agent holds no card yet). The panel still shows, with a close
   *  button, so a click is never answered by nothing. */
  data: AgentRoster | null;
  appearance: RosterAppearance | null;
  /** `dock`: a column beside the office (desktop). `sheet`: a bottom sheet
   *  over the office (mobile, where there is no room beside it). */
  variant: 'dock' | 'sheet';
  onClose: () => void;
}

const FACE_PX = 56;
const TEMP_LINE = 'Just a temp — no XP, back to the agency when done.';

const STATUS_DOT: Record<string, string> = {
  working: 'bg-roster-mint-deep',
  waiting: 'bg-roster-gold',
  idle: 'bg-roster-idle',
};

/** Re-render every second so "time on this task" counts up between messages. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function Stat({ value, label, testId }: { value: string; label: string; testId?: string }) {
  return (
    <div className="bg-roster-box rounded-[4px] p-6 text-center">
      <b data-testid={testId} className="block text-base text-roster-gold font-bold">
        {value}
      </b>
      <span className="text-2xs text-roster-muted">{label}</span>
    </div>
  );
}

/** Fallback face for a temp whose office character is not there to read the look from. */
function tempFace(id: number): { palette: number; hueShift: number } {
  const { sheet, hueShift } = spriteForTemp(id);
  return { palette: sheet, hueShift };
}

/**
 * The roster side panel: who the clicked character is and what they are doing.
 *
 * Pure formatting. The server computes level, XP, stats and the live "right
 * now" block and sends them in `agentRoster`; nothing here derives game state.
 * The one local thing is the clock: time on this task counts up from
 * `taskStartedAt` on a 1 s timer and freezes at `taskEndedAt`.
 */
export function RosterPanel({ data, appearance, variant, onClose }: RosterPanelProps) {
  const running = data !== null && data.now.taskStartedAt !== null && data.now.taskEndedAt === null;
  const now = useNow(running);

  const card = data?.card ?? null;
  const isTemp = data !== null && (data.temp || card === null);
  const name = isTemp ? 'Temp' : (card?.name ?? '');
  const role = isTemp ? 'Temp' : (card?.role ?? '');

  // The card's own sprite when it is loaded, else its hue-shifted bundled
  // fallback (the same look the office gives the character). A temp has no card
  // and shows the character's current look.
  const cardFace =
    !isTemp && card !== null ? spriteForCard(card.spriteIndex, getLoadedCharacterCount()) : null;
  const face = cardFace
    ? { palette: cardFace.sheet, hueShift: cardFace.hueShift }
    : (appearance ?? tempFace(data?.id ?? 0));

  const frame =
    variant === 'dock'
      ? 'relative h-full shrink-0 w-[min(300px,45%)] border-l-2 overflow-y-auto'
      : 'absolute bottom-0 inset-x-0 z-30 max-h-[50%] border-t-2 overflow-y-auto';

  const body = (() => {
    if (data === null) {
      return (
        <p data-testid="roster-pending" className="text-xs text-roster-muted mt-12">
          Waiting for this character&apos;s roster card…
        </p>
      );
    }
    const elapsed = taskElapsedMs(data.now.taskStartedAt, data.now.taskEndedAt, now);
    return (
      <>
        {isTemp ? (
          <p data-testid="roster-temp-line" className="text-xs text-roster-text-soft mt-12">
            {TEMP_LINE}
          </p>
        ) : (
          <>
            <div
              role="progressbar"
              aria-label={`Experience toward level ${data.level.level + 1}`}
              aria-valuemin={0}
              aria-valuemax={Math.round(data.level.xpToNext)}
              aria-valuenow={Math.round(data.level.xpIntoLevel)}
              className="h-[10px] bg-roster-track rounded-[5px] overflow-hidden mt-10"
            >
              <div
                data-testid="roster-xp-fill"
                className="h-full bg-linear-to-r from-roster-mint to-roster-mint-deep"
                style={{ width: `${Math.round(xpFraction(data.level) * 100)}%` }}
              />
            </div>
            <div data-testid="roster-xp-line" className="text-2xs text-roster-muted mt-2">
              {formatXpLine(data.level)}
            </div>
          </>
        )}

        <section
          aria-label="Right now"
          className="bg-roster-box rounded-[4px] p-8 mt-10 border-l-[3px] border-roster-mint"
        >
          <div className="text-2xs uppercase tracking-[1px] text-roster-lavender">Right now</div>
          <div className="mt-2">
            <span
              aria-hidden="true"
              className={`inline-block w-8 h-8 rounded-full mr-4 ${STATUS_DOT[data.now.status] ?? STATUS_DOT.idle}`}
            />
            <b data-testid="roster-status" className="first-letter:uppercase">
              {formatStatus(data.now.status)}
            </b>
            {data.now.projectName && (
              <span data-testid="roster-project"> · {data.now.projectName}</span>
            )}
          </div>
          {data.now.activity && (
            <div data-testid="roster-activity" className="mt-2 break-words">
              {data.now.activity}
            </div>
          )}
          <div className="grid grid-cols-2 gap-6 mt-6">
            <Stat
              testId="roster-task-time"
              value={elapsed === null ? '—' : formatDuration(elapsed)}
              label="on this task"
            />
            <Stat
              testId="roster-task-tokens"
              value={formatTokens(data.now.taskTokens)}
              label="tokens this task"
            />
          </div>
        </section>

        {!isTemp && (
          <>
            <div className="grid grid-cols-3 gap-6 mt-10">
              <Stat value={formatHours(data.stats.workedSeconds)} label="hours worked" />
              <Stat value={formatCount(data.stats.tasksCompleted)} label="tasks completed" />
              <Stat value={formatTokens(data.stats.lifetimeTokens)} label="lifetime tokens" />
            </div>
            {card?.favoriteFact && (
              <figure className="bg-roster-box rounded-[4px] p-8 mt-10 border-l-[3px] border-roster-lavender m-0">
                <figcaption className="text-2xs uppercase tracking-[1px] text-roster-lavender">
                  Favorite fact
                </figcaption>
                <blockquote data-testid="roster-fact" className="m-0 italic break-words">
                  “{card.favoriteFact}”
                </blockquote>
              </figure>
            )}
          </>
        )}
      </>
    );
  })();

  return (
    <aside
      data-testid="roster-panel"
      aria-label="Character roster card"
      className={`${frame} bg-roster-bg text-roster-text border-roster-border p-12 text-xs select-none`}
    >
      <button
        type="button"
        aria-label="Close roster panel"
        onClick={onClose}
        className="absolute right-2 top-2 w-40 h-40 flex items-center justify-center bg-transparent border-0 text-roster-text-soft hover:text-white cursor-pointer text-base leading-none"
      >
        <span aria-hidden="true">✕</span>
      </button>

      <div className="flex items-center gap-10 pr-36">
        <div
          className="shrink-0 rounded-[6px] bg-roster-face-bg border-2 border-roster-gold overflow-hidden flex items-center justify-center"
          style={{ width: FACE_PX + 4, height: FACE_PX + 4 }}
        >
          <CharacterMugShot palette={face.palette} hueShift={face.hueShift} size={FACE_PX} />
        </div>
        <div className="min-w-0">
          <div data-testid="roster-name" className="text-lg font-bold break-words">
            {name}
          </div>
          <div className="text-2xs text-roster-lavender break-words">
            <span data-testid="roster-role">{role}</span>
            {data?.isLead && <span data-testid="roster-lead-tag"> · Team Lead</span>}
          </div>
          {data !== null && !isTemp && (
            <span
              data-testid="roster-level"
              className="inline-block mt-2 bg-roster-gold text-roster-bg font-bold rounded-[4px] px-6 text-2xs"
            >
              {`LV ${data.level.level}`}
            </span>
          )}
        </div>
      </div>

      {body}
    </aside>
  );
}
