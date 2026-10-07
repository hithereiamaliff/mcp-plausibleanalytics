import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeKey } from '../src/analytics/tracker.js';

describe('sanitizeKey', () => {
  it('replaces every character Firebase forbids in keys', () => {
    assert.equal(sanitizeKey('Mozilla/5.0 [x] #1 $'), 'Mozilla_5_0 _x_ _1 _');
    assert.equal(sanitizeKey('foo\tbar\x00baz\x7f'), 'foo_bar_baz_');
    assert.equal(sanitizeKey('plain key'), 'plain key');
  });
});
