import test from 'node:test';
import assert from 'node:assert/strict';
import { getNextExerciseTarget as target, targetPrefill, formatExerciseTarget } from '../js/training-targets.mjs';
import { sessionHistory } from '../js/training-core.mjs';
const args={targetSets:4,repMin:6,repMax:10,increment:2.5,exercise:'ベンチプレス',todayKey:'2026-09-28'};
const history=(pairs,extra={})=>({day:'2026-09-27',sets:pairs.map(([kg,reps,loadMode])=>({kg,reps,...(loadMode?{loadMode}:{})})),...extra});
const mixed=()=>history([[50,10],[60,8],[50,8]]);
const get=(h,extra={})=>target({...args,history:h,...extra});
test('mixed loads retain order, reps and exactly three sets without mutations',()=>{
  const h=[mixed()], before=structuredClone(h), t=get(h);
  assert.deepEqual(t.suggestedSets.map(s=>[s.kg,s.reps]),[[50,10],[60,8],[50,8]]);
  assert.equal(t.weight,null);assert.equal(t.targetTotalReps,26);assert.equal(t.challenge,null);
  assert.deepEqual(h,before);assert.match(formatExerciseTarget(t),/60kg×8回/);
  assert.equal(targetPrefill(t,1).kg,60);assert.equal(targetPrefill(t,2).kg,50);
  assert.deepEqual(targetPrefill(t,3,{kg:45,reps:7}),{kg:45,reps:7});
});
for(const pairs of [[[50,8]],[[50,8],[50,7]],[[16,12],[14,10],[14,8]]]){
  test(`no forced set padding: ${JSON.stringify(pairs)}`,()=>{
    const t=get([history(pairs)]);assert.equal(t.suggestedSets.length,pairs.length);
    assert.equal(t.targetTotalReps,pairs.reduce((n,s)=>n+s[1],0));
  });
}
for(const h of [[],[mixed()],[history([[50,10]])],[history([[50,10],[50,10],[50,10],[50,10]])]]){
  test(`pain precedes first-time/incomplete/full (${h[0]?.sets.length||0} sets)`,()=>{
    const t=get(h,{pain:true,effort:'easy'});assert.equal(t.status,'hold_pain');
    assert.deepEqual(t.suggestedSets,[]);assert.equal(t.targetTotalReps,null);assert.equal(t.challenge,null);
  });
}
test('pain from the previous exercise record blocks candidates too',()=>{
  assert.equal(get([history([[50,8]],{pain:true})],{effort:'easy'}).status,'hold_pain');
});
test('easy feedback suggests exactly one rep at the heavier set; base is unchanged',()=>{
  const t=get([mixed()],{effort:'easy'});
  assert.deepEqual(t.challenge.sets.map(s=>[s.kg,s.reps]),[[50,10],[60,9],[50,8]]);
  assert.equal(t.suggestedSets[1].reps,8);
});
for(const effort of [null,'good','hard'])test(`no challenge with effort=${effort}`,()=>{
  assert.equal(get([mixed()],{effort}).challenge,null);
});
test('two comparable upper-range sessions produce an optional weight candidate',()=>{
  const a=history([[50,10],[50,10],[50,10]],{day:'2026-09-25'}), b=history([[50,10],[50,10],[50,10]],{effort:'easy'});
  const t=get([a,b]);assert.equal(t.weight,50);assert.equal(t.challenge.type,'weight');
  assert.deepEqual(t.challenge.sets.map(s=>[s.kg,s.reps]),[[52.5,6],[52.5,6],[52.5,6]]);
});
test('a single successful day, same-day sessions, or fewer sets never confirm a weight increase',()=>{
  const b=history([[50,10],[50,10]],{effort:'easy'});
  for(const h of [[b],[b,b],[history([[50,10],[50,10],[50,10]],{day:'2026-09-25'}),b]])assert.equal(get(h).challenge,null);
});
test('mixed weight groups increase only a group confirmed at the top twice',()=>{
  const a=history([[50,8],[60,10],[50,7]],{day:'2026-09-25'}), b=history([[50,8],[60,10],[50,7]],{effort:'easy'});
  assert.deepEqual(get([a,b]).challenge.sets.map(s=>[s.kg,s.reps]),[[50,8],[62.5,6],[50,7]]);
});
test('two declines require identical weights, modes and set counts',()=>{
  const a=history([[50,10],[50,10]],{day:'2026-09-23'}),b=history([[50,9],[50,9]],{day:'2026-09-25'}),c=history([[50,8],[50,8]],{effort:'easy'});
  assert.equal(get([a,b,c]).status,'recovery');
  assert.notEqual(get([a,b,history([[50,8]],{effort:'easy'})]).status,'recovery');
  assert.notEqual(get([a,b,history([[50,8],[60,8]],{effort:'easy'})]).status,'recovery');
});
test('14-day break and aborted records are references with no challenge',()=>{
  for(const h of [history([[50,10]],{day:'2026-09-01',effort:'easy'}),history([[50,8]],{sessionStatus:'aborted',effort:'easy'})]){
    const t=get([h]);assert.equal(t.suggestedSets.length,1);assert.equal(t.challenge,null);
  }
});
test('bodyweight pull-ups are never automatically converted into weighted pull-ups',()=>{
  const a=history([[0,10],[0,10]],{day:'2026-09-25'}),b=history([[0,10],[0,10]],{effort:'easy'});
  assert.equal(get([a,b],{exercise:'懸垂'}).challenge,null);
});
test('legacy positive pull-up weights are not assumed to be assistance or added load',()=>{
  const t=get([history([[20,8]],{effort:'easy'})],{exercise:'懸垂'});
  assert.equal(t.challenge,null);assert.equal(t.suggestedSets[0].loadMode,'unknown');
});
test('assistance decreases while added weight increases, respecting equipment step',()=>{
  for(const mode of ['assisted','weighted']){
    const a=history([[30,10]],{day:'2026-09-25'}),b=history([[30,10]],{effort:'easy'});
    a.sets[0].loadMode=b.sets[0].loadMode=mode;
    const t=get([a,b],{exercise:'懸垂',increment:2});
    assert.equal(t.challenge.sets[0].kg,mode==='assisted'?28:32);
  }
});
test('large equipment jumps are not automatically suggested',()=>{
  const a=history([[16,10]],{day:'2026-09-25'}),b=history([[16,10]],{effort:'easy'});
  assert.equal(get([a,b],{increment:2}).challenge,null);
});
test('warm-ups stay in history but are excluded from targets',()=>{
  const h=history([[20,10],[50,8],[50,7]]);h.sets[0].kind='warmup';
  assert.deepEqual(get([h]).suggestedSets.map(s=>s.kg),[50,50]);assert.equal(h.sets.length,3);
});
test('day feedback is matched to the exact last logged set and never rewrites logs',()=>{
  const logs=[{ex:'ベンチプレス',kg:50,reps:8,t:'2026-09-27T10:00:00+09:00'}], before=structuredClone(logs);
  const daily={'2026-09-27':{pain:{'ベンチプレス':true},exerciseFeedback:{'ベンチプレス':{effort:'easy',lastSetAt:logs[0].t}}}};
  const h=sessionHistory(logs,'ベンチプレス',{daily});assert.equal(h[0].effort,'easy');assert.equal(h[0].pain,true);
  daily['2026-09-27'].exerciseFeedback['ベンチプレス'].lastSetAt='old';
  assert.equal(sessionHistory(logs,'ベンチプレス',{daily})[0].effort,null);assert.deepEqual(logs,before);
});
test('sum compatibility fields agree with the actual per-set base',()=>{
  for(const h of [mixed(),history([[50,14],[50,12]]),history([[0,8],[0,6]])]){
    const t=get([h]);assert.equal(t.targetTotalReps,t.suggestedSetTargets.reduce((a,b)=>a+b,0));
  }
});
