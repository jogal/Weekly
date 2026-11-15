import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/hero-reward-core.mjs';

test('stageOf: 0件 / 1件〜 / 半分〜 / 全部', () => {
  assert.equal(R.stageOf({ due: 6, done: 0 }), 0);
  assert.equal(R.stageOf({ due: 6, done: 1 }), 1);
  assert.equal(R.stageOf({ due: 6, done: 2 }), 1);
  assert.equal(R.stageOf({ due: 6, done: 3 }), 2);
  assert.equal(R.stageOf({ due: 6, done: 6 }), 3);
  assert.equal(R.stageOf({ due: 0, done: 0 }), 0);
  assert.equal(R.stageOf({ due: 1, done: 1 }), 3);
  assert.equal(R.stageOf(), 0);
});

test('lineFor: タップごとに順番に変わり、習慣名を差し込む', () => {
  const a = R.lineFor(1, 0, ['英語']), b = R.lineFor(1, 1, ['英語']);
  assert.notEqual(a.text, b.text);
  assert.equal(b.text, '「英語」、見てたぞ。その調子');
  assert.equal(b.move, 'hop');
});

test('lineFor: 名前が無いときは {name} 入りのセリフを使わない', () => {
  for (let t = 0; t < 6; t++) for (let s = 0; s < 4; s++) assert.ok(!R.lineFor(s, t, []).text.includes('{name}'));
});

test('cutOfDay: 同じ日は同じカット、日がちがえば散らばる', () => {
  assert.equal(R.cutOfDay('2026-11-15').id, R.cutOfDay('2026-11-15').id);
  const ids = new Set();
  for (let d = 1; d <= 30; d++) ids.add(R.cutOfDay(`2026-11-${String(d).padStart(2, '0')}`).id);
  assert.ok(ids.size >= 4);
});

test('isOn: off:true のときだけ止まる', () => {
  assert.equal(R.isOn(null), true);
  assert.equal(R.isOn({}), true);
  assert.equal(R.isOn({ off: true }), false);
});
