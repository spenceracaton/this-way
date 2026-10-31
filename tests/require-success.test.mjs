import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSuccess } from '../scripts/require-success.mjs';

test('required validation passes only when every dependency succeeded', () => {
  assert.doesNotThrow(() => requireSuccess(['success', 'success']));
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.throws(() => requireSuccess(['success', result]), /did not succeed/);
  }
  assert.throws(() => requireSuccess([]), /did not succeed/);
});
