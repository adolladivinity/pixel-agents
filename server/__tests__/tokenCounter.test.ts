import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { TokenCounter } from '../src/roster/tokenCounter.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'roster');

/** Lines of a fixture file, exactly as the transcript reader would hand them over. */
function fixtureLines(name: string): string[] {
  return fs
    .readFileSync(path.join(FIXTURES, name), 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0);
}

/** Sum of every delta a counter returns for these lines (nulls count as 0). */
function sumDeltas(counter: TokenCounter, lines: string[]): number {
  return lines.reduce((sum, l) => sum + (counter.addLine(l)?.deltaTokens ?? 0), 0);
}

describe('TokenCounter.usageTotal', () => {
  it('excludes cache reads', () => {
    expect(
      TokenCounter.usageTotal({
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 9999,
      }),
    ).toBe(35);
  });

  it('treats missing, negative and non-numeric fields as 0', () => {
    expect(TokenCounter.usageTotal({})).toBe(0);
    expect(TokenCounter.usageTotal({ input_tokens: -5, output_tokens: 7 })).toBe(7);
    expect(
      TokenCounter.usageTotal({ input_tokens: 'x', output_tokens: NaN } as unknown as {
        input_tokens?: number;
      }),
    ).toBe(0);
  });
});

describe('TokenCounter.addLine', () => {
  it('counts a streamed duplicate message id once, at its final usage', () => {
    const counter = new TokenCounter();
    const results = fixtureLines('streamed-turn.jsonl').map((l) => counter.addLine(l));
    // user line -> null, then one result per rewrite of the same id
    expect(results[0]).toBeNull();
    const deltas = results.slice(1).map((r) => r?.deltaTokens);
    // input 3 + cache_creation 100 + output 1 / 40 / 120; cache_read 5000 is excluded
    expect(deltas).toEqual([104, 39, 80]);
    expect(deltas.reduce((a, b) => a! + b!, 0)).toBe(3 + 100 + 120);
    expect(results[3]?.messageId).toBe('msg_placeholder_0001');
  });

  it('a smaller rewrite of a known id adds 0 and never goes negative', () => {
    const counter = new TokenCounter();
    const line = (out: number) =>
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', role: 'assistant', usage: { output_tokens: out } },
      });
    expect(counter.addLine(line(50))).toEqual({ messageId: 'm1', deltaTokens: 50 });
    expect(counter.addLine(line(10))).toEqual({ messageId: 'm1', deltaTokens: 0 });
    // the max (50) is kept, so growing back to 60 only adds 10
    expect(counter.addLine(line(60))).toEqual({ messageId: 'm1', deltaTokens: 10 });
  });

  it('counts distinct message ids separately', () => {
    const counter = new TokenCounter();
    // turn 1: 2+50+30 = 82 (final), turn 2: 4+0+200 = 204
    expect(sumDeltas(counter, fixtureLines('two-turns-with-subagent.jsonl'))).toBe(82 + 204);
  });

  it('counts subagent lines separately from the parent', () => {
    // Task 8 keeps one counter per transcript file; the subagent file is not folded into the parent.
    const parent = new TokenCounter();
    const subagent = new TokenCounter();
    const parentSum = sumDeltas(parent, fixtureLines('two-turns-with-subagent.jsonl'));
    const subagentSum = sumDeltas(subagent, fixtureLines('subagent-sidechain.jsonl'));
    expect(subagentSum).toBe(5 + 1000 + 900);
    expect(parentSum).toBe(82 + 204);
    // The parent counter never saw the subagent's message id, so none of its tokens leaked in.
    const replay = parent.addLine(fixtureLines('subagent-sidechain.jsonl')[1]);
    expect(replay?.deltaTokens).toBe(5 + 1000 + 500);
  });

  it('skips a partial last line, then counts it once complete', () => {
    const counter = new TokenCounter();
    const [userLine, firstTurn, secondTurn] = fixtureLines('partial-last-line.jsonl');
    expect(counter.addLine(userLine)).toBeNull();
    expect(counter.addLine(firstTurn)).toEqual({
      messageId: 'msg_placeholder_0301',
      deltaTokens: 1 + 10 + 20,
    });

    // Reader has only the first half of the last line so far: it is held back as lineBuffer
    // by readNewLines, but a caller that passes it anyway must get null and no side effects.
    const half = secondTurn.slice(0, Math.floor(secondTurn.length / 2));
    expect(counter.addLine(half)).toBeNull();

    expect(counter.addLine(secondTurn)).toEqual({
      messageId: 'msg_placeholder_0302',
      deltaTokens: 2 + 30 + 70,
    });
  });

  it.each([
    ['empty string', ''],
    ['whitespace', '   \t '],
    ['malformed JSON', '{"type":"assistant","message":{'],
    ['JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
    ['JSON number', '42'],
    ['JSON string', '"text"'],
    ['user line', '{"type":"user","message":{"role":"user","content":"placeholder text"}}'],
    ['assistant without usage', '{"type":"assistant","message":{"id":"m","role":"assistant"}}'],
    ['assistant without id', '{"type":"assistant","message":{"usage":{"output_tokens":5}}}'],
    ['assistant with non-object usage', '{"type":"assistant","message":{"id":"m","usage":7}}'],
    ['assistant with non-string id', '{"type":"assistant","message":{"id":9,"usage":{}}}'],
    ['assistant with non-object message', '{"type":"assistant","message":"x"}'],
  ])('returns null without throwing for %s', (_label, line) => {
    const counter = new TokenCounter();
    expect(() => counter.addLine(line)).not.toThrow();
    expect(counter.addLine(line)).toBeNull();
  });

  it('tolerates a trailing carriage return (CRLF transcripts)', () => {
    const counter = new TokenCounter();
    const line = '{"type":"assistant","message":{"id":"m","usage":{"output_tokens":5}}}\r';
    expect(counter.addLine(line)).toEqual({ messageId: 'm', deltaTokens: 5 });
  });
});
