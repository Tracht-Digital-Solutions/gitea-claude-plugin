import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from '../../src/tools/modules/time.js';

describe('durations', () => {
  it.each([
    [3600, 3600],
    ['5400', 5400],
    ['1h30m', 5400],
    ['1h 30m', 5400],
    ['90m', 5400],
    ['90min', 5400],
    ['2h', 7200],
    ['45s', 45],
    ['1.5h', 5400],
    ['1,5h', 5400],
    ['2std 15min', 8100],
  ] as const)('parses %j', (input, seconds) => {
    expect(parseDuration(input)).toBe(seconds);
  });

  it.each(['', 'soon', '1x', '1h banana'])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow(/Cannot parse duration/);
  });

  it('formats durations', () => {
    expect(formatDuration(5400)).toBe('1h30m');
    expect(formatDuration(3605)).toBe('1h5s');
    expect(formatDuration(0)).toBe('0s');
  });
});
