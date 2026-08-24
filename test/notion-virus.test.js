import test from 'node:test';
import assert from 'node:assert/strict';
import { toViruses, variantFor } from '../src/modules/notion.js';

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `task ${i}` }));

test('variant is stable per id and within range', () => {
  assert.equal(variantFor('abc'), variantFor('abc'));
  assert.ok(variantFor('abc') >= 0 && variantFor('abc') < 3);
});

test('caps at 4 visible with the remainder counted', () => {
  const v = toViruses(mk(9));
  assert.equal(v.viruses.length, 4);
  assert.equal(v.total, 9);
  assert.equal(v.more, 5);
});

test('empty list => nothing to bust', () => {
  const v = toViruses([]);
  assert.equal(v.viruses.length, 0);
  assert.equal(v.total, 0);
  assert.equal(v.more, 0);
});

test('each virus carries a sprite variant', () => {
  const v = toViruses(mk(3));
  for (const virus of v.viruses) {
    assert.ok(virus.id && virus.name);
    assert.ok(virus.variant >= 0 && virus.variant < 3);
  }
});
