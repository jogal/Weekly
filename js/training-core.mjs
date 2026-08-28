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
// opts.slot: slot付きログが1件でも存在すればslot一致だけを見る。まだ存在しない
//            場合のみslotなしlegacyログ(種目名一致)へfallbackする(恒久混在させない)
// opts.sessions: gym_sessions_v2配列。渡すと各summaryにsessionStatusが付く
export function sessionHistory(logs, exercise, opts = {}) {
  const { beforeISO = null, slot = null, limit = 3, sessions = null } = opts;
  const inTime = l => !beforeISO || l.t < beforeISO;
  let hits;
  if (slot) {
    const slotted = logs.filter(l => l.slot === slot && inTime(l));
    hits = slotted.length ? slotted
         : logs.filter(l => !l.slot && l.ex === exercise && inTime(l));
  } else {
    hits = logs.filter(l => l.ex === exercise && inTime(l));
  }
  hits = hits.slice().sort((a, b) => a.t < b.t ? -1 : 1);
  if (!hits.length) return [];

  const statusOf = id => {
    if (!id || !sessions) return null;
    const s = sessions.find(x => x.id === id);
    return s ? s.status : null;
  };
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
    // primary working weight = 最初のセットの重量。ドロップセット(途中で軽くした
    // バックオフ)のrepsをprogressionに数えないため、primary/backoffを分けて派生。
    const primaryWeight = sets[0].kg;
    const primarySets = sets.filter(s => s.kg === primaryWeight);
    const backoffSets = sets.filter(s => s.kg !== primaryWeight);
    return {
      day: localDayKey(group[group.length - 1].t),
      sessionId: group[0].sessionId || null,
      sessionStatus: statusOf(group[0].sessionId),
      sets,                                      // lossless: 全セット保持
      firstWorkingWeight: primaryWeight,
      maxWeight: Math.max(...sets.map(s => s.kg)),
      totalReps: sets.reduce((a, s) => a + s.reps, 0),
      volume: sets.reduce((a, s) => a + s.kg * s.reps, 0),
      primaryWeight,
      primarySets,
      primaryTotalReps: primarySets.reduce((a, s) => a + s.reps, 0),
      backoffSets,
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
  // 中断(aborted)セッションはprogressionの基準にしない(履歴表示には残る)
  const usable = (history || []).filter(h => h.sessionStatus !== "aborted");
  const firstTime = {
    status: "first_time", weight: null,
    targetTotalReps: null, suggestedSetTargets: null,
    reason: `初回。フォームが保てる重量で${repMin}〜${repMax}回×${targetSets}セットを探る`,
  };
  if (!usable.length) return firstTime;

  const last = usable[usable.length - 1];
  const primary = primaryOf(last);
  const w = primary.weight;
  // 戻り値の不変条件: targetTotalReps === sum(suggestedSetTargets)
  const finish = (status, weight, arr, reason) => ({
    status, weight,
    targetTotalReps: arr.reduce((a, b) => a + b, 0),
    suggestedSetTargets: arr, reason,
  });

  // 前回が予定セット数未満(primaryセット基準) → progressionを進めず、まずやり切る
  if (primary.sets.length < targetSets) {
    const arr = setTargetsFrom(primary.sets, targetSets, repMin, repMax, 0);
    return finish("incomplete_prev", w, arr,
      `前回は${primary.sets.length}/${targetSets}セット。${fmtWt(w)}でまず${targetSets}セットをやり切る`);
  }
  const hitTop = primary.sets.slice(0, targetSets).every(s => s.reps >= repMax);
  if (hitTop && !pain) {
    const nw = Math.round((w + increment) * 10) / 10;
    return finish("increase_weight", nw, Array(targetSets).fill(repMin),
      `前回${fmtWt(w)}で全セット${repMax}回到達 → +${increment}kg。${repMin}回×${targetSets}セットから再構築`);
  }
  if (pain) {
    const arr = setTargetsFrom(primary.sets, targetSets, repMin, repMax, 0);
    return finish("hold_pain", w, arr,
      "痛みの報告があるため増量を止め、前回と同等を維持。悪化するなら中止を");
  }
  // 同一primary重量で2回連続の明確な低下 → plateau(重量維持・volume増やさない)
  if (usable.length >= 3) {
    const [a, b, c] = usable.slice(-3).map(h => ({ p: primaryOf(h) }));
    if (a.p.weight === w && b.p.weight === w &&
        b.p.total < a.p.total && c.p.total < b.p.total) {
      const arr = setTargetsFrom(primary.sets, targetSets, repMin, repMax, 0);
      return finish("plateau", w, arr,
        "2回連続でパフォーマンス低下。重量・volumeを増やさず、睡眠と食事の回復を優先");
    }
  }
  const cap = targetSets * repMax;
  const target = Math.min(primary.total + 2, cap);
  const arr = setTargetsFrom(primary.sets, targetSets, repMin, repMax, target);
  return finish("progress_reps", w, arr,
    `${fmtWt(w)}を維持し、計${primary.total}回 → ${target}回以上を狙う`);
}

// summaryからprimary working weightのセット群を取り出す。
// 古いsummary(primarySetsなし)にも対応(先頭セット重量で自前derive)。
function primaryOf(h) {
  const sets = h.primarySets ?? h.sets.filter(s => s.kg === h.sets[0].kg);
  const weight = h.primaryWeight ?? h.sets[0].kg;
  return { weight, sets, total: sets.reduce((a, s) => a + s.reps, 0) };
}

function fmtWt(w) { return w === 0 ? "自重" : w + "kg"; }

// 前回のprimaryセットrepsを土台にtargetSets本の目標rep配列を作る。
// 足りないセットはrepMinで埋め、targetTotalに届くまで先頭から+1ずつ(上限repMax)。
// targetTotal=0なら配分だけ(維持目標)。
function setTargetsFrom(prevSets, targetSets, repMin, repMax, targetTotal) {
  const base = [];
  for (let i = 0; i < targetSets; i++) {
    const r = prevSets[i] ? prevSets[i].reps : repMin;
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

// ── Body condition(体重7日移動平均・増量ペース判定) ──────────────────────────
// daily: gym_daily_v2形式 {dateKey: {weightKg?, proteinG?}}
// endKeyを含む過去windowDays日のうち、記録がある日だけの平均
export function movingAvgWeight(daily, endKey, windowDays = 7) {
  const end = new Date(endKey + "T12:00:00");
  const ws = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    const w = daily[localDayKey(d)]?.weightKg;
    if (typeof w === "number") ws.push(w);
  }
  if (!ws.length) return null;
  return Math.round(ws.reduce((a, b) => a + b, 0) / ws.length * 100) / 100;
}

// 増量ペース判定(カロリー記録は要求しない)。目安0.1〜0.25%BW/週。
// - 14(なければ21)日前の7日平均と比較し、+0.1kg未満なら停滞、>0.3%/週なら速め
export function weightTrend(daily, todayKey) {
  const avg7 = movingAvgWeight(daily, todayKey);
  if (avg7 == null) {
    return { status: "no_data", avg7: null, perWeek: null,
      message: "体重を記録すると7日平均とペース判定が出ます" };
  }
  const back = n => {
    const d = new Date(todayKey + "T12:00:00"); d.setDate(d.getDate() - n);
    return movingAvgWeight(daily, localDayKey(d));
  };
  const avg14 = back(14), avg21 = back(21);
  const ref = avg14 ?? avg21;
  const refDays = avg14 != null ? 14 : (avg21 != null ? 21 : null);
  if (refDays == null) {
    return { status: "insufficient", avg7, perWeek: null,
      message: "記録を2週間続けるとペース判定が出ます" };
  }
  const perWeek = Math.round((avg7 - ref) / (refDays / 7) * 100) / 100;
  const pctPerWeek = perWeek / avg7 * 100;
  if (avg7 - ref < 0.1) {
    return { status: "stalled", avg7, perWeek,
      message: "増量が止まっています。食事を約100〜150kcal/日増やすことを検討" };
  }
  if (pctPerWeek > 0.3) {
    return { status: "fast", avg7, perWeek,
      message: `増量速度が速め(+${perWeek.toFixed(2)}kg/週)。目安は0.1〜0.25%/週` };
  }
  return { status: "ok", avg7, perWeek,
    message: `良いペース(+${perWeek.toFixed(2)}kg/週)` };
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
