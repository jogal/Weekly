// habit-core.mjs — 習慣トラッカー（目標・連続記録・ゴールド・ショップ）の純粋ロジック。
// DOMにもlocalStorageにも触らない。記録の正本は次の2つで、ここでは読むだけ：
//   - wt_records       … 既存の5トラック(筋トレ/専門医/楽器/英語/自炊)に連動する習慣
//   - wt_habit_log_v1  … 自分で追加した習慣の回数・分数と、休息日フラグ
// ゴールドは記録から日ごとに計算し直す。直近SETTLE_WINDOW日より前は確定して
// 合計(bank)に畳み込む。だから記録を取り消せばゴールドも戻り、二重計上もしない。

export const KEYS = { habits: "wt_habits_v1", log: "wt_habit_log_v1", reward: "wt_reward_v1" };
export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"];
export const SETTLE_WINDOW = 7;      // 直近7日は後から記録しても反映される
const MAX_WALK_DAYS = 1200;
const MAX_WALK_WEEKS = 200;

// ── 日付キー("YYYY-MM-DD")ユーティリティ。UTC計算でタイムゾーンの影響を受けない ──
const DAY_MS = 86400000;
const pad = n => String(n).padStart(2, "0");
export function keyOfDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function toUTC(key) { const [y, m, d] = key.split("-").map(Number); return Date.UTC(y, m - 1, d); }
function fromUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function addDays(key, n) { return fromUTC(toUTC(key) + n * DAY_MS); }
export function weekdayIdx(key) { return (new Date(toUTC(key)).getUTCDay() + 6) % 7; } // 月=0
export function mondayOf(key) { return addDays(key, -weekdayIdx(key)); }
export function daysBetween(a, b) { return Math.round((toUTC(b) - toUTC(a)) / DAY_MS); }

// ── 習慣の定義 ───────────────────────────────────────────────────────────────
export const LINKS = {
  workout:    { label: "筋トレ",     icon: "💪", color: "#E57373" },
  medicine:   { label: "専門医勉強", icon: "🧠", color: "#FFA726" },
  instrument: { label: "楽器練習",   icon: "🎵", color: "#7986CB" },
  english:    { label: "英語学習",   icon: "🌐", color: "#26C6DA" },
  cooking:    { label: "自炊",       icon: "🍳", color: "#66BB6A" },
  // 読書は本棚(wt_reading_v1)と連動。進んだページ数は ctx.readPages(key) から。XP・習慣のゴールドは付かない(ページのゴールドだけ)
  reading:    { label: "読書",       icon: "📖", color: "#8FB3D9" },
};
export const HABIT_COLORS = ["#E57373", "#FFA726", "#dfbd7c", "#66BB6A", "#26C6DA",
  "#7986CB", "#BA68C8", "#F06292", "#90A4AE"];
export const ICON_SUGGESTIONS = ["🪥", "🧘", "🚶", "📖", "💧", "🛏️", "☀️", "🥗", "✍️", "🧹", "💊", "🎧"];
export const GOAL_TYPES = ["check", "count", "minutes"];
export const FREQ_TYPES = ["daily", "days", "weekly"];

// 連動習慣で選べる目標。筋トレは「部位数」、それ以外は「時間」を数えられる
export function allowedGoalTypes(link) {
  if (!link) return GOAL_TYPES;
  return link === "workout" || link === "reading" ? ["check", "count"] : ["check", "minutes"];
}

export function defaultHabits(todayKey) {
  const linked = (link, freq) => ({
    id: "h_" + link, name: LINKS[link].label, icon: LINKS[link].icon, color: LINKS[link].color,
    link, goal: { type: "check", target: 1 }, freq,
  });
  return [
    linked("workout", { type: "weekly", days: [], times: 4 }),
    linked("medicine", { type: "daily", days: [], times: 1 }),
    linked("english", { type: "daily", days: [], times: 1 }),
    linked("instrument", { type: "daily", days: [], times: 1 }),
    linked("cooking", { type: "daily", days: [], times: 1 }),
  ].map(h => normalizeHabit({ ...h, createdOn: todayKey }));
}

const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
export function normalizeHabit(h) {
  const link = h && LINKS[h.link] ? h.link : null;
  let goalType = GOAL_TYPES.includes(h?.goal?.type) ? h.goal.type : "check";
  if (!allowedGoalTypes(link).includes(goalType)) goalType = "check";
  let freqType = FREQ_TYPES.includes(h?.freq?.type) ? h.freq.type : "daily";
  let days = Array.isArray(h?.freq?.days)
    ? [...new Set(h.freq.days.map(Number).filter(d => d >= 0 && d <= 6))].sort() : [];
  if (freqType === "days" && !days.length) freqType = "daily";
  if (freqType !== "days") days = [];
  return {
    id: String(h?.id || "h_" + Date.now().toString(36)),
    name: String(h?.name || (link ? LINKS[link].label : "新しい習慣")).slice(0, 40),
    icon: String(h?.icon || (link ? LINKS[link].icon : "✨")).slice(0, 8),
    color: /^#[0-9a-fA-F]{6}$/.test(h?.color || "") ? h.color : (link ? LINKS[link].color : HABIT_COLORS[2]),
    link,
    goal: { type: goalType, target: goalType === "check" ? 1 : clampInt(h?.goal?.target, 1, 999, goalType === "minutes" ? 15 : 2) },
    freq: { type: freqType, days, times: freqType === "weekly" ? clampInt(h?.freq?.times, 1, 7, 3) : 1 },
    createdOn: /^\d{4}-\d{2}-\d{2}$/.test(h?.createdOn || "") ? h.createdOn : null,
    archived: !!h?.archived,
    archivedOn: h?.archived && /^\d{4}-\d{2}-\d{2}$/.test(h?.archivedOn || "") ? h.archivedOn : null,
  };
}
// 保存済みの習慣リストを読み、無ければ5トラック連動の初期習慣を返す。
// 読書の習慣が無ければ足す(readingFrom: 本棚の最初の記録日。それより前の日は対象外)
export function readingHabit(fromKey) {
  return normalizeHabit({ id: "h_reading", link: "reading", goal: { type: "check", target: 1 },
    freq: { type: "daily", days: [], times: 1 }, createdOn: fromKey });
}
export function ensureHabits(saved, todayKey, readingFrom = null) {
  const list = Array.isArray(saved?.habits) ? saved.habits.map(normalizeHabit) : null;
  const habits = list && list.length ? list : defaultHabits(todayKey);
  if (!habits.some(h => h.link === "reading")) habits.push(readingHabit(readingFrom && readingFrom < todayKey ? readingFrom : todayKey));
  return { habits };
}

// ── 進捗・判定 ───────────────────────────────────────────────────────────────
function recDay(records, key) { return records?.[mondayOf(key)]?.[DAY_KEYS[weekdayIdx(key)]] || null; }
const mins = r => parseInt(r?.duration, 10) || 0;
export function targetOf(h) { return h.goal.type === "check" ? 1 : Math.max(1, h.goal.target | 0); }

export function progressOf(h, key, ctx) {
  if (h.link === "reading") {
    const n = Math.max(0, Number(ctx.readPages?.(key)) || 0);
    return h.goal.type === "count" ? n : n > 0 ? 1 : 0;
  }
  if (h.link) {
    const day = recDay(ctx.records, key);
    if (!day) return 0;
    const recs = h.link === "workout"
      ? Object.keys(day).filter(c => c.startsWith("workout_")).map(c => day[c])
      : [day[h.link]];
    const done = recs.filter(r => r?.done);
    if (h.goal.type === "minutes") return done.reduce((a, r) => a + mins(r), 0);
    if (h.goal.type === "count") return done.length;
    return done.length ? 1 : 0;
  }
  return Math.max(0, Number(ctx.log?.[key]?.[h.id]?.n) || 0);
}
export function isAchieved(h, key, ctx) { return progressOf(h, key, ctx) >= targetOf(h); }
export function isRest(h, key, ctx) { return !!ctx.log?.[key]?.[h.id]?.rest; }
export function isFrozen(h, key, ctx) { return (ctx.freezes?.[key] || []).includes(h.id); }
export function isDue(h, key) {
  if (h.freq.type === "days") return h.freq.days.includes(weekdayIdx(key));
  return h.freq.type === "daily";
}
// 期間の対象になる日か(独自習慣は作成日から、アーカイブ後は対象外)
export function isActiveOn(h, key) {
  if ((!h.link || h.link === "reading") && h.createdOn && key < h.createdOn) return false;
  if (h.archivedOn && key >= h.archivedOn) return false;
  return true;
}
// 最も古い記録日。連続記録をさかのぼる下限に使う
export function dataFloor(records, log) {
  let floor = null;
  const take = k => { if (/^\d{4}-\d{2}-\d{2}$/.test(k) && (!floor || k < floor)) floor = k; };
  Object.keys(records || {}).forEach(take);
  Object.keys(log || {}).forEach(take);
  return floor;
}

// ── 連続記録 ─────────────────────────────────────────────────────────────────
// 毎日/曜日指定: keyの日で終わる連続日数。予定外の曜日・休息日・護符で守られた日は
// 数えないが途切れもしない
export function dailyStreakAt(h, key, ctx) {
  let n = 0, k = key;
  for (let i = 0; i < MAX_WALK_DAYS; i++, k = addDays(k, -1)) {
    if (ctx.floorKey && k < ctx.floorKey) break;
    if (!isDue(h, k)) continue;
    if (isAchieved(h, k, ctx)) { n++; continue; }
    if (isRest(h, k, ctx) || isFrozen(h, k, ctx)) continue;
    break;
  }
  return n;
}
export function weekCount(h, monKey, ctx, uptoKey = null) {
  let c = 0;
  for (let i = 0; i < 7; i++) {
    const k = addDays(monKey, i);
    if (uptoKey && k > uptoKey) break;
    if (isAchieved(h, k, ctx)) c++;
  }
  return c;
}
// 週N回: keyの週(key時点で達成済みなら1)＋それ以前に続けて達成した週数
export function weeklyStreakAt(h, key, ctx) {
  const mon = mondayOf(key), times = h.freq.times;
  let n = weekCount(h, mon, ctx, key) >= times ? 1 : 0;
  let m = addDays(mon, -7);
  for (let i = 0; i < MAX_WALK_WEEKS; i++, m = addDays(m, -7)) {
    if (ctx.floorKey && addDays(m, 6) < ctx.floorKey) break;
    if (weekCount(h, m, ctx) >= times) { n++; continue; }
    if (isFrozen(h, m, ctx)) continue;
    break;
  }
  return n;
}
// 表示用の現在の連続記録。今日がまだなら昨日までの記録を保つ
export function currentStreak(h, today, ctx) {
  if (h.freq.type === "weekly") return { n: weeklyStreakAt(h, today, ctx), unit: "w" };
  const n = isAchieved(h, today, ctx) ? dailyStreakAt(h, today, ctx) : dailyStreakAt(h, addDays(today, -1), ctx);
  return { n, unit: "d" };
}
// 期間内の最長連続
export function bestStreak(h, from, to, ctx) {
  let run = 0, best = 0;
  if (h.freq.type === "weekly") {
    for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) {
      if (weekCount(h, m, ctx) >= h.freq.times) { run++; best = Math.max(best, run); }
      else if (!isFrozen(h, m, ctx) && addDays(m, 6) < (ctx.today || to)) run = 0;
    }
    return { n: best, unit: "w" };
  }
  for (let k = from; k <= to; k = addDays(k, 1)) {
    if (!isDue(h, k)) continue;
    if (isAchieved(h, k, ctx)) { run++; best = Math.max(best, run); }
    else if (!isRest(h, k, ctx) && !isFrozen(h, k, ctx) && k !== ctx.today) run = 0;
  }
  return { n: best, unit: "d" };
}

// 統計カレンダー用の日ごとの状態: done / miss / rest(休息日・護符) / off(予定のない日・作る前) / future
// 週N回の習慣は、やっていない日を miss(ただの空き)として扱う
export function habitDayState(h, key, ctx, today) {
  if (key > today) return "future";
  if (!isActiveOn(h, key)) return "off";
  if (isAchieved(h, key, ctx)) return "done";
  if (h.freq.type !== "weekly" && !isDue(h, key)) return "off";
  if (isRest(h, key, ctx) || isFrozen(h, key, ctx)) return "rest";
  return "miss";
}
export function habitDays(h, from, to, ctx, today) {
  const out = [];
  for (let k = from; k <= to; k = addDays(k, 1)) out.push({ key: k, state: habitDayState(h, k, ctx, today) });
  return out;
}

// ── 達成率 ───────────────────────────────────────────────────────────────────
// 休息日・護符の日は分母から除く。今日が未達成ならまだ数えない
export function habitRate(h, from, to, today, ctx) {
  const end = to < today ? to : today;
  let due = 0, ok = 0;
  if (h.freq.type === "weekly") {
    for (let m = mondayOf(from); m <= end; m = addDays(m, 7)) {
      if (!isActiveOn(h, addDays(m, 6)) && !isActiveOn(h, m)) continue;
      const met = weekCount(h, m, ctx) >= h.freq.times;
      const ended = addDays(m, 6) < today;
      if (isFrozen(h, m, ctx) && !met) continue;
      if (met || ended) { due++; if (met) ok++; }
    }
  } else {
    for (let k = from; k <= end; k = addDays(k, 1)) {
      if (!isActiveOn(h, k) || !isDue(h, k)) continue;
      const ach = isAchieved(h, k, ctx);
      if (!ach && (isRest(h, k, ctx) || isFrozen(h, k, ctx) || k === today)) continue;
      due++; if (ach) ok++;
    }
  }
  return { due, ok, rate: due ? ok / due : null };
}
// 日付ストリップのリング用: その日に予定のある習慣のうち達成した数
// 日付ストリップのリング用: dayCompletion と同じ数え方で、1習慣ごとの {color, done}
export function daySegments(habits, key, ctx) {
  const out = [];
  for (const h of habits) {
    if (!isActiveOn(h, key)) continue;
    const ach = isAchieved(h, key, ctx);
    if ((h.freq.type === "weekly" || !isDue(h, key) || isRest(h, key, ctx)) && !ach) continue;
    out.push({ id: h.id, color: h.color, done: ach });
  }
  return out;
}
export function dayCompletion(habits, key, ctx) {
  let due = 0, done = 0;
  for (const h of habits) {
    if (!isActiveOn(h, key)) continue;
    const ach = isAchieved(h, key, ctx);
    if (h.freq.type === "weekly") { if (ach) { due++; done++; } continue; }
    if (!isDue(h, key) || isRest(h, key, ctx)) { if (ach) { due++; done++; } continue; }
    due++; if (ach) done++;
  }
  return { due, done };
}

// ── ゴールド ─────────────────────────────────────────────────────────────────
export const GOLD = {
  base: 10,           // 目標達成1回
  streakStep: 1,      // 連続2日目から1日ごとに+1
  streakCap: 20,      // 連続ボーナスの上限
  weekGoal: 20,       // 週N回を達成した日
  weekStreakStep: 5,  // 連続週ボーナス
  weekStreakCap: 30,
  perfect: 20,        // その日の予定の習慣(2つ以上)をすべて達成
  welcome: 100,       // はじめてボーナス
};
export const MILESTONES = {
  d: [[7, 50], [30, 200], [100, 700], [365, 3000]],
  w: [[4, 50], [12, 200], [26, 700], [52, 3000]],
};
export const MEDAL_ICONS = ["🥉", "🥈", "🥇", "🏆"];
export function medalIcon(unit, tier) {
  const i = MILESTONES[unit].findIndex(([t]) => t === tier);
  return MEDAL_ICONS[Math.max(0, i)];
}

export function habitDayGold(h, key, ctx) {
  if (h.link === "reading") return null; // 読書のゴールドは本棚のページ分だけ(二重に付けない)
  if (!isActiveOn(h, key) || !isAchieved(h, key, ctx)) return null;
  if (h.freq.type === "weekly") {
    let g = GOLD.base, streak = 0, ms = 0;
    if (weekCount(h, mondayOf(key), ctx, key) === h.freq.times) {
      streak = weeklyStreakAt(h, key, ctx);
      g += GOLD.weekGoal + Math.min((streak - 1) * GOLD.weekStreakStep, GOLD.weekStreakCap);
      const m = MILESTONES.w.find(([t]) => t === streak);
      if (m) { ms = m[0]; g += m[1]; }
    }
    return { g, streak, unit: "w", ms };
  }
  if (!isDue(h, key)) return { g: GOLD.base, streak: 0, unit: "d", ms: 0 };
  const streak = dailyStreakAt(h, key, ctx);
  let g = GOLD.base + Math.min((streak - 1) * GOLD.streakStep, GOLD.streakCap), ms = 0;
  const m = MILESTONES.d.find(([t]) => t === streak);
  if (m) { ms = m[0]; g += m[1]; }
  return { g, streak, unit: "d", ms };
}
export function perfectGold(habits, key, ctx) {
  const due = habits.filter(h => isActiveOn(h, key) && h.freq.type !== "weekly"
    && isDue(h, key) && !isRest(h, key, ctx));
  return due.length >= 2 && due.every(h => isAchieved(h, key, ctx)) ? GOLD.perfect : 0;
}

// ── ごほうび状態 ─────────────────────────────────────────────────────────────
export function newRewardState(todayKey) {
  return {
    v: 1, startedOn: todayKey, settledThrough: null,
    bank: 0, medals: [], days: {},
    grants: [{ g: GOLD.welcome, reason: "welcome", on: todayKey }],
    purchases: [], freezes: {},
    quests: { claimed: {} },
    wishes: defaultWishes(), tickets: [],
  };
}
export function normalizeReward(r, todayKey) {
  if (!r || typeof r !== "object" || !r.startedOn) return newRewardState(todayKey);
  return {
    v: 1, startedOn: r.startedOn, settledThrough: r.settledThrough || null,
    bank: Number(r.bank) || 0,
    medals: Array.isArray(r.medals) ? r.medals : [],
    days: r.days && typeof r.days === "object" ? r.days : {},
    grants: Array.isArray(r.grants) ? r.grants : [],
    // 称号・おとも・背景は廃止: 以前に買った分は購入ごと取り消してゴールドを返す
    purchases: (Array.isArray(r.purchases) ? r.purchases : []).filter(isLivePurchase),
    freezes: r.freezes && typeof r.freezes === "object" ? r.freezes : {},
    quests: { claimed: { ...(r.quests?.claimed || {}) } },
    // ごほうびリストが未設定なら初期の3つ。自分で全部消した([])ならそのまま
    wishes: Array.isArray(r.wishes) ? r.wishes.map(normalizeWish) : defaultWishes(),
    tickets: Array.isArray(r.tickets) ? r.tickets.filter(t => t && t.id) : [],
  };
}
const clone = o => JSON.parse(JSON.stringify(o));
const dayGold = d => Object.values(d?.items || {}).reduce((a, e) => a + (e.g || 0), 0) + (d?.perfect || 0);
export function balance(r) {
  return r.bank
    + Object.values(r.days).reduce((a, d) => a + dayGold(d), 0)
    + r.grants.reduce((a, x) => a + (x.g || 0), 0)
    - r.purchases.reduce((a, p) => a + (p.price || 0), 0);
}
export function goldOn(r, key) { return dayGold(r.days[key]); }
export function shieldCount(r) {
  const bought = r.purchases.filter(p => p.item === "shield").length;
  const used = Object.values(r.freezes).reduce((a, ids) => a + ids.length, 0);
  return bought - used;
}
export function medals(r) {
  const out = new Map();
  const add = m => { const id = `${m.habitId}:${m.unit}${m.tier}`; if (!out.has(id)) out.set(id, m); };
  r.medals.forEach(add);
  Object.keys(r.days).sort().forEach(k => {
    Object.entries(r.days[k].items || {}).forEach(([habitId, e]) => {
      if (e.ms) add({ habitId, unit: e.unit, tier: e.ms, on: k });
    });
  });
  return [...out.values()];
}

function freeze(r, key, id) { (r.freezes[key] = r.freezes[key] || []).push(id); }
function unfreeze(r, key, id) {
  r.freezes[key] = (r.freezes[key] || []).filter(x => x !== id);
  if (!r.freezes[key].length) delete r.freezes[key];
}
// 記録を忘れた日を護符で守る(過去日のみ)。後から記録されたら護符を返す
function applyShields(r, habits, k, ctx) {
  for (const h of habits) {
    if (!isActiveOn(h, k)) continue;
    if (h.freq.type === "weekly") {
      if (weekdayIdx(k) !== 6) continue;
      const mon = mondayOf(k), met = weekCount(h, mon, ctx) >= h.freq.times, fr = isFrozen(h, mon, ctx);
      if (met && fr) unfreeze(r, mon, h.id);
      else if (!met && !fr && shieldCount(r) > 0 && weeklyStreakAt(h, addDays(mon, -1), ctx) > 0) freeze(r, mon, h.id);
      continue;
    }
    if (!isDue(h, k)) continue;
    const fr = isFrozen(h, k, ctx);
    if (isAchieved(h, k, ctx) || isRest(h, k, ctx)) { if (fr) unfreeze(r, k, h.id); continue; }
    if (!fr && shieldCount(r) > 0 && dailyStreakAt(h, addDays(k, -1), ctx) > 0) freeze(r, k, h.id);
  }
}

// 未確定の日(前回確定日の翌日〜今日)のゴールドを記録から計算し直す。冪等
export function settle(reward, habits, ctx, today) {
  const r = clone(reward);
  const start = r.settledThrough ? addDays(r.settledThrough, 1) : r.startedOn;
  const c = { ...ctx, freezes: r.freezes, today };
  for (let k = start; k <= today; k = addDays(k, 1)) {
    if (k < today) applyShields(r, habits, k, c);
    const items = {};
    for (const h of habits) { const e = habitDayGold(h, k, c); if (e) items[h.id] = e; }
    // 日課・タスクなど習慣以外のゴールド(ctx.extraGold(k) → {id:{g}})
    if (ctx.extraGold) Object.assign(items, ctx.extraGold(k));
    const perfect = perfectGold(habits, k, c);
    if (Object.keys(items).length || perfect) r.days[k] = { items, perfect }; else delete r.days[k];
  }
  // 7日より前は確定して合計に畳み込む(保存データを小さく保つ)
  const frozenTo = addDays(today, -SETTLE_WINDOW);
  if (frozenTo >= r.startedOn && (!r.settledThrough || frozenTo > r.settledThrough)) {
    r.medals = medals(r).filter(m => m.on <= frozenTo);
    Object.keys(r.days).filter(k => k <= frozenTo).forEach(k => { r.bank += dayGold(r.days[k]); delete r.days[k]; });
    r.settledThrough = frozenTo;
  }
  return r;
}

// ── ショップ ─────────────────────────────────────────────────────────────────
export const SHIELD_MAX = 3;
export const SHOP = [
  { id: "shield", kind: "shield", name: "まもりの護符", icon: "🧿", price: 100,
    desc: "記録を忘れた日も連続記録を守る。自動で使われ、3つまで持てる" },
];
export const SHOP_KINDS = [{ kind: "wish", label: "ごほうび" }, { kind: "shield", label: "どうぐ" }];
// 今も有効な購入(護符とごほうびチケット)。廃止したアイテムの購入は読み込み時に取り除く
const isLivePurchase = p => !!p && (p.item === "shield" || String(p.item).startsWith("ticket:"));
export function shopItem(id) { return SHOP.find(i => i.id === id) || null; }
export function purchase(r, itemId, today) {
  const it = shopItem(itemId);
  if (!it) return { ok: false, reason: "unknown" };
  if (shieldCount(r) >= SHIELD_MAX) return { ok: false, reason: "max" };
  if (balance(r) < it.price) return { ok: false, reason: "gold" };
  const n = clone(r);
  n.purchases.push({ item: it.id, price: it.price, on: today });
  return { ok: true, state: n };
}

// ── ごほうびチケット(リアルの自分へのごほうび) ──────────────────────────────
// ごほうびリストに名前と値段を登録し、ゴールドでチケットを買う。チケットは1枚1回、
// 実際にごほうびを楽しんだときに「使う」。購入時の名前・値段はチケットに写して残す
export const WISH_ICONS = ["♨️", "🍻", "🛍️", "🍰", "🍣", "🎬", "💆", "📚", "🎮", "☕", "✈️", "🎁"];
export const DEFAULT_WISHES = [
  { id: "w_sauna", name: "サウナに行く", icon: "♨️", price: 700 },
  { id: "w_drink", name: "飲みに行く", icon: "🍻", price: 1000 },
  { id: "w_shopping", name: "買い物チケット", icon: "🛍️", price: 1500 },
];
export const WISH_PRICE_MIN = 10, WISH_PRICE_MAX = 99999;
function defaultWishes() { return DEFAULT_WISHES.map(w => ({ ...w })); }
export function normalizeWish(w) {
  return {
    id: String(w?.id || "w_" + Date.now().toString(36)),
    name: String(w?.name || "ごほうび").trim().slice(0, 30) || "ごほうび",
    icon: String(w?.icon || "🎁").slice(0, 8),
    price: clampInt(w?.price, WISH_PRICE_MIN, WISH_PRICE_MAX, 500),
  };
}
export function saveWish(r, wish) {
  const n = clone(r), w = normalizeWish(wish);
  const i = n.wishes.findIndex(x => x.id === w.id);
  if (i >= 0) n.wishes[i] = w; else n.wishes.push(w);
  return n;
}
// リストから消しても、買ったチケットはそのまま残る
export function deleteWish(r, id) {
  const n = clone(r);
  n.wishes = n.wishes.filter(w => w.id !== id);
  return n;
}
export function buyTicket(r, wishId, today) {
  const w = r.wishes.find(x => x.id === wishId);
  if (!w) return { ok: false, reason: "unknown" };
  if (balance(r) < w.price) return { ok: false, reason: "gold" };
  const n = clone(r);
  const id = "tk" + (n.tickets.length + 1);
  const ticket = { id, wishId: w.id, name: w.name, icon: w.icon, price: w.price, boughtOn: today, usedOn: null };
  n.tickets.push(ticket);
  n.purchases.push({ item: "ticket:" + w.id, price: w.price, on: today, ticket: id });
  return { ok: true, state: n, ticket };
}
export function useTicket(r, ticketId, today) {
  const t = r.tickets.find(x => x.id === ticketId);
  if (!t) return { ok: false, reason: "unknown" };
  if (t.usedOn) return { ok: false, reason: "used" };
  const n = clone(r);
  n.tickets.find(x => x.id === ticketId).usedOn = today;
  return { ok: true, state: n };
}
export function unusedTickets(r) { return r.tickets.filter(t => !t.usedOn); }
export function usedTickets(r) {
  return r.tickets.filter(t => t.usedOn).sort((a, b) => b.usedOn.localeCompare(a.usedOn) || b.id.localeCompare(a.id));
}
// 値段の目安: 直近7日(今日を除く)の1日あたりの稼ぎ
export function goldPerDay(r, today) {
  let sum = 0;
  for (let i = 1; i <= SETTLE_WINDOW; i++) sum += goldOn(r, addDays(today, -i));
  return sum / SETTLE_WINDOW;
}
export function daysOfEffort(price, perDay) { return perDay > 0 ? Math.max(1, Math.round(price / perDay)) : null; }

// ── 記録の書き込み(純粋関数: 新しいオブジェクトを返す) ───────────────────────
// 独自習慣: 値を設定(0以下で消す)。休息フラグは残す
export function setLogValue(log, key, id, n) {
  const out = clone(log || {});
  const day = out[key] || {};
  const cur = { ...(day[id] || {}) };
  if (n > 0) cur.n = n; else delete cur.n;
  if (Object.keys(cur).length) day[id] = cur; else delete day[id];
  if (Object.keys(day).length) out[key] = day; else delete out[key];
  return out;
}
export function setRest(log, key, id, rest) {
  const out = clone(log || {});
  const day = out[key] || {};
  const cur = { ...(day[id] || {}) };
  if (rest) cur.rest = true; else delete cur.rest;
  if (Object.keys(cur).length) day[id] = cur; else delete day[id];
  if (Object.keys(day).length) out[key] = day; else delete out[key];
  return out;
}
// 連動習慣: wt_recordsのその日の1日分を変更して返す(メモ・評価は保持)
//   {type:"toggle"}            チェック(筋トレ以外)
//   {type:"minutes", delta}    分を加減。0分になったら未完了に戻す
//   {type:"part", part, on}    筋トレの部位を完了/取り消し
export function linkedDayPatch(day, h, change) {
  const out = { ...(day || {}) };
  const base = c => ({ done: false, note: "", duration: "", rating: 0, ...(out[c] || {}) });
  if (h.link === "workout") {
    if (change.type === "part" && change.part) {
      const c = "workout_" + change.part;
      out[c] = { ...base(c), done: !!change.on };
    }
    return out;
  }
  const c = h.link, cur = base(c);
  if (change.type === "toggle") out[c] = { ...cur, done: !cur.done };
  else if (change.type === "minutes") {
    const total = Math.max(0, mins(cur) + (Number(change.delta) || 0));
    out[c] = { ...cur, duration: total ? String(total) : "", done: total > 0 };
  }
  return out;
}

// ── 表示用ラベル ─────────────────────────────────────────────────────────────
export function freqLabel(h) {
  if (h.freq.type === "weekly") return `週${h.freq.times}回`;
  if (h.freq.type === "days") {
    const d = h.freq.days.join(",");
    if (d === "0,1,2,3,4") return "平日";
    if (d === "5,6") return "週末";
    return h.freq.days.map(i => WEEKDAY_LABELS[i]).join("・");
  }
  return "毎日";
}
export function unitLabel(h) {
  if (h.goal.type === "minutes") return "分";
  if (h.goal.type === "count") return h.link === "workout" ? "部位" : h.link === "reading" ? "ページ" : "回";
  return "";
}
export function progressLabel(h, key, ctx) {
  if (h.freq.type === "weekly") {
    const c = weekCount(h, mondayOf(key), ctx);
    const today = h.goal.type === "check" ? "" : ` · 今日${progressOf(h, key, ctx)}/${targetOf(h)}${unitLabel(h)}`;
    return `今週 ${c}/${h.freq.times}${today}`;
  }
  if (h.goal.type === "check") return "";
  return `${progressOf(h, key, ctx)}/${targetOf(h)}${unitLabel(h)}`;
}
export function streakLabel(s) { return s.n > 0 ? `${s.n}${s.unit === "w" ? "週" : "日"}` : ""; }
