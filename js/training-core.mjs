// training-core.mjs — 純粋ロジック層（DOM・localStorage・fetch禁止）
// gym.html のWorkout機能から使う。すべてpure functionでnode:testでテスト可能。

// ── Workout cycle ─────────────────────────────────────────────────────────────
// A→B→C→D→A… を週をまたいでも維持する。週で回数が足りなくてもスキップしない。
export const TEMPLATE_ORDER = ["A", "B", "C", "D"];

export function nextTemplateId(lastCompletedTemplateId, order = TEMPLATE_ORDER) {
  if (!order || !order.length) return "A";
  const i = order.indexOf(lastCompletedTemplateId);
  if (i < 0) return order[0];
  return order[(i + 1) % order.length];
}

// ── 前回パフォーマンス ────────────────────────────────────────────────────────
// logs(gym_logs形式・時系列昇順が原則)から、指定種目の「直近の実施日」のセット群を返す。
// beforeISO を渡すとそれより前だけを見る(進行中セッションの自セットを除外するため)。
export function lastSessionSets(logs, exercise, beforeISO = null) {
  const sets = logs.filter(l => l.ex === exercise && (!beforeISO || l.t < beforeISO));
  if (!sets.length) return null;
  const dayOf = iso => iso.slice(0, 10);
  const lastDay = sets.reduce((a, l) => dayOf(l.t) > a ? dayOf(l.t) : a, "");
  const daySets = sets.filter(l => dayOf(l.t) === lastDay)
    .sort((a, b) => a.t < b.t ? -1 : 1);
  return {
    day: lastDay,
    kg: daySets[daySets.length - 1].kg,
    maxKg: Math.max(...daySets.map(s => s.kg || 0)),
    reps: daySets.map(s => s.reps),
    totalReps: daySets.reduce((a, s) => a + s.reps, 0),
    volume: daySets.reduce((a, s) => a + (s.kg || 0) * s.reps, 0),
    sets: daySets.length,
  };
}

// セッション中の入力プリフィル: 直前セット > 前回実績 > null
export function prefillFor(sessionSets, previous) {
  if (sessionSets && sessionSets.length) {
    const last = sessionSets[sessionSets.length - 1];
    return { kg: last.kg, reps: last.reps };
  }
  if (previous) return { kg: previous.kg, reps: previous.reps[0] ?? 10 };
  return null;
}
