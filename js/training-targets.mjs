// Deterministic, read-only target proposals. No storage, DOM or network access.
// Base = last recorded working sets; challenge = optional, never auto-applied.
export function loadModeOf(set, exercise = '') {
  if (['external', 'bodyweight', 'weighted', 'assisted'].includes(set.loadMode)) return set.loadMode;
  return /懸垂/.test(exercise) ? (set.kg === 0 ? 'bodyweight' : 'unknown') : 'external';
}
export function formatTargetSet(s) {
  const weight = s.loadMode === 'assisted' ? `補助${s.kg}kg`
    : s.loadMode === 'weighted' ? `加重${s.kg}kg`
    : s.kg === 0 ? '自重' : `${s.kg}kg`;
  return `${weight}×${s.reps}回`;
}
export function formatExerciseTarget(t) {
  return t.suggestedSets.length ? t.suggestedSets.map(formatTargetSet).join(' → ') : t.reason;
}
export function targetPrefill(target, index, fallback = { kg: 0, reps: 10 }) {
  const sets = target.suggestedSets;
  return { ...(sets[index] || fallback) }; // extra sets are manual, not a new requirement
}
export function getNextExerciseTarget({ history = [], repMin = 6, repMax = 10,
  increment = 2.5, pain = false, effort = null, exercise = '', todayKey = null }) {
  const working = h => (h.sets || []).filter(s => s.kind !== 'warmup' &&
    Number.isFinite(s.kg) && s.kg >= 0 && Number.isInteger(s.reps) && s.reps > 0)
    .map(s => ({ kg: s.kg, reps: s.reps, loadMode: loadModeOf(s, exercise) }));
  const usable = history.map(h => ({ ...h, working: working(h) })).filter(h => h.working.length);
  const last = usable.at(-1);
  const output = (status, sets, reason, challenge = null) => ({
    status, suggestedSets: sets.map(s => ({ ...s })), reason, challenge,
    // Legacy consumers may still use these fields. Mixed weights have no single weight.
    weight: sets.length && sets.every(s => s.kg === sets[0].kg && s.loadMode === sets[0].loadMode) ? sets[0].kg : null,
    suggestedSetTargets: sets.length ? sets.map(s => s.reps) : null,
    targetTotalReps: sets.length ? sets.reduce((n, s) => n + s.reps, 0) : null,
  });
  // This must precede first-time, short-session and challenge handling.
  if (pain || history.at(-1)?.pain || last?.pain) return output('hold_pain', [],
    '痛みの記録があります。重量・回数・セット数の目標提案を休止しています。痛みのある動作を無理に続けないでください。');
  if (!last) return output('first_time', [],
    `初回は無理のない重量・回数で記録。${repMin}〜${repMax}回は目安です。セット追加は任意です。`);
  const base = last.working;
  const summary = `前回の${base.length}セットを基本に。セット追加は任意です。`;
  const hold = (status, reason) => output(status, base, summary + reason);
  const gap = todayKey && last.day ? (Date.parse(todayKey + 'T12:00:00Z') - Date.parse(last.day + 'T12:00:00Z')) / 86400000 : 0;
  // 14 days is a conservative product rule, not a physiological cutoff.
  if (gap >= 14) return hold('returning', '間隔が空いているため挑戦の提案は休止。前回値は参考にし、今日の状態に合わせて調整できます。');
  if (last.sessionStatus === 'aborted' || last.sessionStatus === 'active')
    return hold('partial_reference', '途中までの記録も残しています。今回は再現を目安にします。');
  const sameLayout = h => h && h.working.length === base.length && h.working.every((s, i) =>
    s.kg === base[i].kg && s.loadMode === base[i].loadMode);
  const recent = usable.slice(-3);
  if (recent.length === 3 && recent.every(sameLayout)) {
    const totals = recent.map(h => h.working.reduce((n, s) => n + s.reps, 0));
    if (totals[0] > totals[1] && totals[1] > totals[2])
      return hold('recovery', '同じ重量・セット構成で回数が続けて減っています。上積みは提案せず、回復を優先できます。');
  }
  const feel = effort || last.effort;
  if (feel === 'hard') return hold('hold_effort', '前回または今日の手応えは「きつい」。上積みせず、軽くする・少なくする調整もできます。');
  if (feel !== 'easy') return hold('repeat', '余裕があるときだけ小さな挑戦を選べます。');
  if (base.some(s => s.loadMode === 'unknown'))
    return hold('repeat', '以前の懸垂の重量方式が不明なため、増量は提案しません。今後の記録で方式を選べます。');
  const previous = usable.at(-2);
  const stable = sameLayout(previous) && !previous.pain &&
    !['aborted', 'active'].includes(previous.sessionStatus) && previous.effort !== 'hard' &&
    last.day !== previous.day && (!last.day || !previous.day ||
      Date.parse(last.day + 'T12:00:00Z') - Date.parse(previous.day + 'T12:00:00Z') < 14 * 86400000);
  // Increase only a weight group that reached the top twice in the same layout.
  // Never interpret more assistance as a heavier challenge.
  const groups = [...new Set(base.map(s => `${s.loadMode}:${s.kg}`))];
  for (const group of groups) {
    const indices = base.map((s, i) => `${s.loadMode}:${s.kg}` === group ? i : -1).filter(i => i >= 0);
    const s = base[indices[0]];
    const smallStep = Number.isFinite(increment) && increment > 0 && s.kg > 0 && increment / s.kg <= 0.1;
    if (stable && smallStep && s.loadMode !== 'bodyweight' && indices.every(i =>
      base[i].reps >= repMax && previous.working[i].reps >= repMax)) {
      const kg = Math.max(0, Math.round((s.kg + (s.loadMode === 'assisted' ? -increment : increment)) * 10) / 10);
      const sets = base.map((set, i) => indices.includes(i)
        ? { ...set, kg, reps: repMin, loadMode: s.loadMode === 'assisted' && kg === 0 ? 'bodyweight' : s.loadMode }
        : { ...set });
      return output('repeat', base, summary, { type: 'weight', sets,
        reason: '同じ構成で2回、回数上限に到達。余裕があればこの重量で試す候補です。自動では変更しません。' });
    }
  }
  // One additional rep in one set, prioritising the higher external load.
  const candidates = base.map((s, i) => ({ ...s, i })).filter(s => s.reps < repMax)
    .sort((a, b) => (a.loadMode === 'assisted' ? a.kg - b.kg : b.kg - a.kg) || a.i - b.i);
  if (candidates.length) {
    const index = candidates[0].i;
    const sets = base.map((s, i) => ({ ...s, reps: s.reps + (i === index ? 1 : 0) }));
    return output('repeat', base, summary, { type: 'rep', sets,
      reason: `${index + 1}セット目だけ＋1回。前回の再現でも十分です。` });
  }
  return hold('repeat', '回数上限に到達しています。増量の条件・重量刻みを確認できるまでは前回を再現する目安です。');
}
