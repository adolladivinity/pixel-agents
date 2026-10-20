/**
 * Per-message token deltas from Claude Code session JSONL lines.
 *
 * Pure and stateful only in memory: the caller (one counter per transcript file) feeds it
 * lines the transcript reader already produced, and adds the returned deltas to a card's
 * lifetime tokens. It never opens files or watches anything.
 *
 * Why deltas, not totals: Claude Code writes one JSONL line per content block, so a single
 * assistant message id appears several times while it streams, each time with a usage block
 * whose output_tokens has grown. Counting every line would multiply the message; counting
 * only the last line would need to know which line is last. Instead each id remembers the
 * highest total seen, and a line contributes only the growth over that. Summed, a message
 * always equals its final usage, and a rewrite with smaller usage adds 0 (never negative).
 *
 * Tokens = input + cache creation + output. Cache reads are excluded: they re-read the same
 * context every turn and would swamp the real work.
 */

export interface TokenUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TokenDelta {
  messageId: string;
  /** Growth of this message id's counted total; 0 for a repeat or smaller rewrite. */
  deltaTokens: number;
}

/** A usable counter value: finite and non-negative, anything else counts as 0. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export class TokenCounter {
  /**
   * message id -> highest total counted so far. One entry per assistant message in one
   * session transcript (a few thousand small entries at most); a counter lives and dies with
   * its transcript, so no eviction is needed.
   */
  private readonly counted = new Map<string, number>();

  /** input + cache creation + output; cache reads are deliberately left out. */
  static usageTotal(usage: TokenUsage): number {
    return (
      count(usage.input_tokens) +
      count(usage.cache_creation_input_tokens) +
      count(usage.output_tokens)
    );
  }

  /**
   * Parse one JSONL line. Returns the increase of the message id's counted total for an
   * assistant line with an id and a usage block (0 when it adds nothing new), and null for
   * everything else: user/system lines, missing id or usage, empty, malformed or partial
   * JSON. Never throws, so a half-written line is simply ignored and counted when the
   * complete line arrives.
   */
  addLine(line: string): TokenDelta | null {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (!trimmed) return null;

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      return null;
    }
    return this.addRecord(record);
  }

  /**
   * Same as `addLine` for a record the caller has already parsed (the transcript reader
   * parses every line once; this avoids a second parse). Never throws.
   */
  addRecord(record: unknown): TokenDelta | null {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;

    const { type, message } = record as { type?: unknown; message?: unknown };
    if (type !== 'assistant') return null;
    if (typeof message !== 'object' || message === null) return null;

    const { id, usage } = message as { id?: unknown; usage?: unknown };
    if (typeof id !== 'string' || id === '') return null;
    if (typeof usage !== 'object' || usage === null) return null;

    const total = TokenCounter.usageTotal(usage as TokenUsage);
    const previous = this.counted.get(id) ?? 0;
    if (total <= previous) return { messageId: id, deltaTokens: 0 };

    this.counted.set(id, total);
    return { messageId: id, deltaTokens: total - previous };
  }
}
