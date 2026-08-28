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
export function sessionHistory(logs, exercise, opts = {}) {
  const { beforeISO = null, slot = null, limit = 3 } = opts;
  const match = l => {
    if (beforeISO && l.t >= beforeISO) return false;
    if (slot) return l.slot === slot || (!l.slot && l.ex === exercise);
    return l.ex === exercise;
  };
  const hits = logs.filter(match).sort((a, b) => a.t < b.t ? -1 : 1);
  if (!hits.length) return [];

  const keyOf = l => l.sessionId ? "s:" + l.sessionId : "d:" + localDayKey(l.t);
  const groups = [];   // 出現順(=時系列)にグループ化
  const byKey = {};
  hits.forEach(l => {
    const k = keyOf(l);
    if (!byKey[k]) { byKey[k] = []; groups.push(byKey[k]); }
    byKey[k].push(l);
  });
  return groups.slice(-limit).map(group => {
    const sets = group.map(l => ({ kg: l.kg || 0, reps: l.reps }));
    return {
      day: localDayKey(group[group.length - 1].t),
      sessionId: group[0].sessionId || null,
      sets,                                      // lossless: ドロップセット保持
      firstWorkingWeight: sets[0].kg,
      maxWeight: Math.max(...sets.map(s => s.kg)),
      totalReps: sets.reduce((a, s) => a + s.reps, 0),
      volume: sets.reduce((a, s) => a + s.kg * s.reps, 0),
    };
  });
}

export function lastSessionSets(logs, exercise, opts = {}) {
  const h = sessionHistory(logs, exercise, { ...opts, limit: 1 });
  return h.length ? h[h.length - 1] : null;
}

// ── Progressive overload engine (double progression / deterministic) ─────────
// LLM非依存の純関数。history は sessionHistory() の戻り(時系列昇順・直近が末尾)。
//
// ルール:
// - 履歴なし → first_time(重量を探る)
// - 全targetSetsがrepMax到達(同一重量) → incrementだけ増量し、repMin×setsから再構築
// - それ以外 → 重量維持で total reps +2 を狙う(double progression)
// - 1回のrep低下では重量を下げない(そのまま維持目標)
// - 同一重量で2回連続の明確な低下 → plateau(重量維持・volume増やさない提案のみ。
//   勝手にdeloadしない)
// - pain=true → いかなる場合も増量しない(維持目標)。医療判断はしない
export function getNextExerciseTarget({ history, targetSets, repMin, repMax, increment, pain = false }) {
  if (!history || !history.length) {
    return {
      status: "first_time", weight: null,
      targetTotalReps: null, suggestedSetTargets: null,
      reason: `初回。フォームが保てる重量で${repMin}〜${repMax}回×${targetSets}セットを探る`,
    };
  }
  const last = history[history.length - 1];
  const w = last.firstWorkingWeight;
  const uniform = last.sets.every(s => s.kg === w);
  const hitTop = uniform && last.sets.length >= targetSets &&
    last.sets.slice(0, targetSets).every(s => s.reps >= repMax);

  if (hitTop && !pain) {
    const nw = Math.round((w + increment) * 10) / 10;
    return {
      status: "increase_weight", weight: nw,
      targetTotalReps: targetSets * repMin,
      suggestedSetTargets: Array(targetSets).fill(repMin),
      reason: `前回${fmtWt(w)}で全セット${repMax}回到達 → +${increment}kg。${repMin}回×${targetSets}セットから再構築`,
    };
  }
  if (pain) {
    return {
      status: "hold_pain", weight: w,
      targetTotalReps: last.totalReps,
      suggestedSetTargets: setTargetsFrom(last, targetSets, repMin, repMax, last.totalReps),
      reason: "痛みの報告があるため増量を止め、前回と同等を維持。悪化するなら中止を",
    };
  }
  // 同一重量で2回連続の明確な低下 → plateau
  if (history.length >= 3) {
    const [a, b, c] = history.slice(-3);
    if (a.firstWorkingWeight === w && b.firstWorkingWeight === w &&
        b.totalReps < a.totalReps && c.totalReps < b.totalReps) {
      return {
        status: "plateau", weight: w,
        targetTotalReps: last.totalReps,
        suggestedSetTargets: setTargetsFrom(last, targetSets, repMin, repMax, last.totalReps),
        reason: "2回連続でパフォーマンス低下。重量・volumeを増やさず、睡眠と食事の回復を優先",
      };
    }
  }
  const cap = targetSets * repMax;
  const target = Math.min(last.totalReps + 2, cap);
  return {
    status: "progress_reps", weight: w,
    targetTotalReps: target,
    suggestedSetTargets: setTargetsFrom(last, targetSets, repMin, repMax, target),
    reason: `${fmtWt(w)}を維持し、計${last.totalReps}回 → ${target}回以上を狙う`,
  };
}

function fmtWt(w) { return w === 0 ? "自重" : w + "kg"; }

// 前回の各セットrepsを土台に、合計がtargetTotalになるよう先頭セットから+1ずつ
// 配分する(上限repMax)。前回よりセット数が少なければrepMinで埋める。
function setTargetsFrom(last, targetSets, repMin, repMax, targetTotal) {
  const base = [];
  for (let i = 0; i < targetSets; i++) {
    const r = last.sets[i] ? last.sets[i].reps : repMin;
    base.push(Math.min(Math.max(r, 1), repMax));
  }
  let sum = base.reduce((a, b) => a + b, 0);
  let guard = targetSets * repMax;
  let i = 0;
  while (sum < targetTotal && guard-- > 0) {
    if (base[i % targetSets] < repMax) { base[i % targetSets]++; sum++; }
    i++;
  }
  return base;
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
