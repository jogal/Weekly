import test from 'node:test';
import assert from 'node:assert/strict';
import { questView, trainingDays, routeDay, monkSpriteCandidates, creditedSessions } from '../js/gym-quest.mjs';
import { DEFAULT_TEMPLATES } from '../js/training-data.mjs';
process.env.TZ = 'Asia/Tokyo';
const tpl = DEFAULT_TEMPLATES[0];
const logs = tpl.exercises.map((e,i) => ({ ...e, t:`2026-09-26T16:0${i}:00Z`, kg:20, reps:10 }));

test('0–5 unique exercises: neutral partial, main, bonus, full; order is free', () => {
  const labels=['0 / 3 CLEAR','1 / 3 CLEAR','2 / 3 CLEAR','MAIN QUEST CLEAR','BONUS CLEAR','FULL CLEAR'];
  for(let n=0;n<=5;n++) {
    const result=questView(tpl,logs.slice(0,n).reverse());
    assert.equal(result.label,labels[n]);
    assert.equal(result.complete,n>=3);
    if(n>0&&n<3)assert.equal(result.note,`今日は${n}/5。記録は残っています。`);
  }
});
test('repeated sets and exercises outside the quest never inflate progress', () => {
  const input=[logs[0],logs[0],{ex:'スクワット'}];
  const before=JSON.stringify(input);
  assert.equal(questView(tpl,input).done,1);
  assert.equal(JSON.stringify(input),before);
});
test('deleting the third distinct exercise immediately removes clear display', () => {
  assert.equal(questView(tpl,logs.slice(0,3)).stage,'main');
  assert.equal(questView(tpl,logs.slice(0,2)).stage,'idle');
});
test('week training count includes partial days and deduplicates multiple sessions in local time', () => {
  const dates=['2026-09-27','2026-09-28'];
  assert.deepEqual([...trainingDays([...logs,{t:'2026-09-27T16:00:00Z'},{t:'2026-09-26T14:59:00Z'}],dates)],dates);
});
test('route preserves planner decisions and presents rest/partial records neutrally', () => {
  assert.equal(routeDay({status:'done'},true).label,'CLEAR');
  assert.equal(routeDay({status:'blocked'},true).label,'LOGGED');
  assert.equal(routeDay({status:'blocked'},false).label,'BLOCKED');
  assert.equal(routeDay({status:'ok',recommended:true},false).label,'QUEST');
  assert.equal(routeDay({status:'past'},false).detail,'RECOVERY DAY');
});
test('all five sprite tiers have a lower-tier fallback', () => {
  for(const tier of [1,10,20,30,40]) {
    const c=monkSpriteCandidates(tier);
    assert.equal(c[0],`sprites/monk-actions/lv${tier}.webp`);
    assert.equal(c[1],`sprites/monk_lv${tier}x2.png`);
    assert.equal(c.at(-1),'sprites/monk.png');
  }
});
test('today plan credit follows remaining logs without rewriting completed history', () => {
  const sessions=[{date:'2026-09-27',status:'completed',templateId:'MAIN'},
    {date:'2026-09-20',status:'completed',templateId:'MAIN'}];
  const before=JSON.stringify(sessions);
  assert.equal(creditedSessions(sessions,logs.slice(0,3),{templates:[tpl]},'2026-09-27').length,2);
  assert.deepEqual(creditedSessions(sessions,logs.slice(0,2),{templates:[tpl]},'2026-09-27'),[sessions[1]]);
  assert.equal(JSON.stringify(sessions),before);
});
