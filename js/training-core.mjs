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

// sessions配列(gym_sessions_v2形式)から直近の完了テンプレートIDを返す。
// active/abortedはサイクルを進めない。
export function lastCompletedTemplateIdFrom(sessions) {
  if (!Array.isArray(sessions)) return null;
  const done = sessions.filter(s => s && s.status === "completed");
  return done.length ? done[done.length - 1].templateId : null;
}

// ── 日付(既存アプリと同じlocal date key。UTCのslice(0,10)は使わない) ─────────
export function localDayKey(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 前日以前から放置されたactive sessionか(再開/中断の確認を出す判定)
export function isStaleSession(session, todayKey) {
  return !!(session && session.status === "active" &&
    session.date && session.date !== todayKey);
}

// ── 前回パフォーマンス ────────────────────────────────────────────────────────
// gym_logs形式のlogsから、指定種目の「直近の1回のワークアウト」のセット群を返す。
//
// - グルーピングはsessionIdを最優先(Workout mode由来)。sessionIdのない
//   legacyログはlocal日付でまとめる(既存アプリと同じ日界)。
// - 各セットを{kg,reps}のまま保持する。ドロップセット(途中で重量変更)でも
//   情報を失わない。firstWorkingWeight等は派生値。
// - opts.beforeISO: それより前のログだけを見る(進行中セッションの自セット除外)
// - opts.slot: template slot ID(例 "A1")。指定時はslot一致を優先しつつ、
//   slotを持たないlegacyログは種目名一致で対象に含める(後方互換)。
export function lastSessionSets(logs, exercise, opts = {}) {
  const { beforeISO = null, slot = null } = opts;
  const match = l => {
    if (beforeISO && l.t >= beforeISO) return false;
    if (slot) return l.slot === slot || (!l.slot && l.ex === exercise);
    return l.ex === exercise;
  };
  const hits = logs.filter(match);
  if (!hits.length) return null;

  const keyOf = l => l.sessionId ? "s:" + l.sessionId : "d:" + localDayKey(l.t);
  // 直近ログの属するグループを採用
  const latest = hits.reduce((a, l) => l.t > a.t ? l : a, hits[0]);
  const key = keyOf(latest);
  const group = hits.filter(l => keyOf(l) === key).sort((a, b) => a.t < b.t ? -1 : 1);

  const sets = group.map(l => ({ kg: l.kg || 0, reps: l.reps }));
  return {
    day: localDayKey(group[group.length - 1].t),
    sessionId: latest.sessionId || null,
    sets,                                        // lossless: ドロップセット保持
    firstWorkingWeight: sets[0].kg,
    maxWeight: Math.max(...sets.map(s => s.kg)),
    totalReps: sets.reduce((a, s) => a + s.reps, 0),
    volume: sets.reduce((a, s) => a + s.kg * s.reps, 0),
  };
}

// セッション中の入力プリフィル: 直前セット > 前回実績の1セット目 > null
export function prefillFor(sessionSets, previous) {
  if (sessionSets && sessionSets.length) {
    const last = sessionSets[sessionSets.length - 1];
    return { kg: last.kg, reps: last.reps };
  }
  if (previous && previous.sets.length) {
    return { kg: previous.sets[0].kg, reps: previous.sets[0].reps };
  }
  return null;
}
