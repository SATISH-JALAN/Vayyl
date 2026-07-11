import { describe, expect, it } from 'vitest';
import { parseStaleResponse } from './stale';

describe('parseStaleResponse', () => {
  it('accepts only an explicit true response', () => {
    expect(parseStaleResponse('true\n')).toBe(true);
    expect(parseStaleResponse('false')).toBe(false);
    expect(parseStaleResponse('error: not true')).toBe(false);
  });
});
