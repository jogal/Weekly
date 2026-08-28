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
// endKeyを含む過去windowDays日のウィンドウ統計(記録がある日だけ)。
// countはtrend判定のminimum data coverageチェックに使う
export function weightWindowStats(daily, endKey, windowDays = 7) {
  const end = new Date(endKey + "T12:00:00");
  const ws = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    const w = daily[localDayKey(d)]?.weightKg;
    if (typeof w === "number") ws.push(w);
  }
  return {
    avg: ws.length ? Math.round(ws.reduce((a, b) => a + b, 0) / ws.length * 100) / 100 : null,
    count: ws.length,
  };
}
// 既存互換API(平均だけ返す)
export function movingAvgWeight(daily, endKey, windowDays = 7) {
  return weightWindowStats(daily, endKey, windowDays).avg;
}

// 増量ペース判定(カロリー記録は要求しない)。目安0.1〜0.25%BW/週。
// - 判定にはcurrent/referenceウィンドウとも測定4件以上を要求(coverage不足はinsufficient)
// - 判定は%BW/週で行い、14日ref/21日refのどちらでも同じペースなら同じstatusになる
//   stalled: <=0.02%/週(横ばい・減少) → +100〜150kcal提案はこの場合だけ
//   slow:    <0.1%/週(増えてはいる) → 様子見
//   ok:      0.1〜0.3%/週(0.25〜0.30は許容境界)
//   fast:    >0.3%/週
const MIN_WINDOW_COUNT = 4;
export function weightTrend(daily, todayKey) {
  const cur = weightWindowStats(daily, todayKey);
  if (!cur.count) {
    return { status: "no_data", avg7: null, perWeek: null,
      message: "体重を記録すると7日平均とペース判定が出ます" };
  }
  const back = n => {
    const d = new Date(todayKey + "T12:00:00"); d.setDate(d.getDate() - n);
    return weightWindowStats(daily, localDayKey(d));
  };
  const ref14 = back(14), ref21 = back(21);
  let ref = null, refDays = null;
  if (ref14.count >= MIN_WINDOW_COUNT) { ref = ref14; refDays = 14; }
  else if (ref21.count >= MIN_WINDOW_COUNT) { ref = ref21; refDays = 21; }
  if (cur.count < MIN_WINDOW_COUNT || !ref) {
    return { status: "insufficient", avg7: cur.avg, count: cur.count, perWeek: null,
      message: "記録を2週間続けるとペース判定が出ます(週4日以上の測定推奨)" };
  }
  const perWeek = Math.round((cur.avg - ref.avg) / (refDays / 7) * 1000) / 1000;
  const pctPerWeek = perWeek / cur.avg * 100;
  const base = { avg7: cur.avg, count: cur.count, perWeek, pctPerWeek, refDays };
  if (pctPerWeek <= 0.02) {
    return { ...base, status: "stalled",
      message: "増量が止まっています。食事を約100〜150kcal/日増やすことを検討" };
  }
  if (pctPerWeek < 0.1) {
    return { ...base, status: "slow",
      message: `ややゆっくり(+${perWeek.toFixed(2)}kg/週)。もう少し経過を見る` };
  }
  if (pctPerWeek > 0.3) {
    return { ...base, status: "fast",
      message: `増量速度が速め(+${perWeek.toFixed(2)}kg/週)。目安は0.1〜0.25%/週` };
  }
  return { ...base, status: "ok", message: `良いペース(+${perWeek.toFixed(2)}kg/週)` };
}

// 最新体重のsource of truth: gym_daily_v2の最新weightKg > fallback(profile値)
export function latestWeightKg(daily, fallback = null) {
  const keys = Object.keys(daily || {})
    .filter(k => typeof daily[k]?.weightKg === "number").sort();
  return keys.length ? daily[keys[keys.length - 1]].weightKg : fallback;
}

// AI Coach向けタンパク質サマリ(直近7日・todayKey含む)
export function proteinSummary(daily, todayKey, target = 105) {
  const end = new Date(todayKey + "T12:00:00");
  const vals = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    const g = daily[localDayKey(d)]?.proteinG;
    if (typeof g === "number") vals.push(g);
  }
  return {
    avg7: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null,
    recordedDays: vals.length,
    daysAtLeast90: vals.filter(g => g >= 90).length,
    todayG: daily[todayKey]?.proteinG ?? null,
    targetG: target,
  };
}

// ── Quest連携(表示専用ミラー) ────────────────────────────────────────────────
// XP/レベルのsource of truthはtracker側(wt_records)。ここはtrackerと同一式を
// 読み取り専用で再現し、完了リワードの表示にだけ使う。値の保存はしない。
// ※TECH DEBT(Phase 8): この式はtracker.htmlと重複している。式を変更する場合は
//   両方を同時に更新すること。Phase 8でquest rulesのshared pure module化を検討。
export const QUEST_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function xpForQuestRecord(rec) {
  if (!rec?.done) return 0;
  let xp = 10;
  if (rec.duration) xp += Math.min(20, Math.floor((parseInt(rec.duration) || 0) / 5));
  if (rec.rating) xp += rec.rating * 2;
  return xp;
}
export function questXpToReach(level) {
  if (level <= 1) return 0;
  return Math.round(50 * Math.pow(level - 1, 1.6));
}
export function questLevelFromXP(totalXP) {
  let lvl = 1;
  while (totalXP >= questXpToReach(lvl + 1)) lvl++;
  return lvl;
}
export function questTierOf(lvl) {
  return lvl >= 40 ? 40 : lvl >= 30 ? 30 : lvl >= 20 ? 20 : lvl >= 10 ? 10 : 1;
}

// wt_recordsから筋トレトラック(全workout_*合算)の状態を導出。
// 減衰(7日猶予後8XP/日)もtrackerと同一式で反映する
export function monkStateFromRecords(records, todayKey) {
  let raw = 0;
  let lastDone = null;   // dateKey
  Object.entries(records || {}).forEach(([wk, week]) => {
    QUEST_DAY_KEYS.forEach((dk, di) => {
      const day = week?.[dk];
      if (!day) return;
      Object.entries(day).forEach(([catId, rec]) => {
        if (!catId.startsWith("workout_")) return;
        raw += xpForQuestRecord(rec);
        if (rec?.done) {
          const [y, m, d] = wk.split("-").map(Number);
          const dt = new Date(y, m - 1, d + di);
          const key = localDayKey(dt);
          if (!lastDone || key > lastDone) lastDone = key;
        }
      });
    });
  });
  let xp = raw;
  if (lastDone && raw > 0 && todayKey) {
    const idle = Math.round((new Date(todayKey + "T12:00:00") - new Date(lastDone + "T12:00:00")) / 86400000);
    const decayDays = Math.max(0, idle - 7);
    xp = Math.max(0, raw - Math.min(raw, decayDays * 8));
  }
  const lvl = questLevelFromXP(xp);
  return { rawXP: raw, xp, lvl, tier: questTierOf(lvl), lastDone };
}

// 同一templateの直近completed sessionでのexercise pain flag。
// Workout UIとAI Coach payloadの両方がこれを使い、pain判定を統一する
export function lastSessionPainFlag(sessions, templateId, key) {
  const done = (sessions || []).filter(s => s.status === "completed" && s.templateId === templateId);
  const last = done[done.length - 1];
  return !!(last && last.pain && last.pain[key]);
}

// 完了リワードのdelta計算。baselineはWorkout開始時のsnapshot
// {rawXP, displayXP, lvl}(sessionのoptional metadata)。
// - earnedXPはraw XPの差分のみ: decay解除で表示XPが戻った分は「獲得」に含めない
// - leveledUpは表示レベル(decay込み)の比較: 実際にLvが上がればtrue
// - baselineがないlegacy sessionでは earnedXP:null(表示を省略させる)
export function monkRewardDelta(baseline, after) {
  if (!after || !baseline || typeof baseline.rawXP !== "number") {
    return { earnedXP: null, leveledUp: false };
  }
  return {
    earnedXP: Math.max(0, after.rawXP - baseline.rawXP),
    leveledUp: typeof baseline.lvl === "number" && after.lvl > baseline.lvl,
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
