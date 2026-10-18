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
};
export const HABIT_COLORS = ["#E57373", "#FFA726", "#dfbd7c", "#66BB6A", "#26C6DA",
  "#7986CB", "#BA68C8", "#F06292", "#90A4AE"];
export const ICON_SUGGESTIONS = ["🪥", "🧘", "🚶", "📖", "💧", "🛏️", "☀️", "🥗", "✍️", "🧹", "💊", "🎧"];
export const GOAL_TYPES = ["check", "count", "minutes"];
export const FREQ_TYPES = ["daily", "days", "weekly"];

// 連動習慣で選べる目標。筋トレは「部位数」、それ以外は「時間」を数えられる
export function allowedGoalTypes(link) {
  if (!link) return GOAL_TYPES;
  return link === "workout" ? ["check", "count"] : ["check", "minutes"];
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
// 保存済みの習慣リストを読み、無ければ5トラック連動の初期習慣を返す
export function ensureHabits(saved, todayKey) {
  const list = Array.isArray(saved?.habits) ? saved.habits.map(normalizeHabit) : null;
  return { habits: list && list.length ? list : defaultHabits(todayKey) };
}

// ── 進捗・判定 ───────────────────────────────────────────────────────────────
function recDay(records, key) { return records?.[mondayOf(key)]?.[DAY_KEYS[weekdayIdx(key)]] || null; }
const mins = r => parseInt(r?.duration, 10) || 0;
export function targetOf(h) { return h.goal.type === "check" ? 1 : Math.max(1, h.goal.target | 0); }

export function progressOf(h, key, ctx) {
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
  if (!h.link && h.createdOn && key < h.createdOn) return false;
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
    purchases: [], freezes: {}, owned: [],
    equipped: { title: null, bg: null },
    quests: { claimed: {} },
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
    // おともは休止中: 以前に買ったおともは購入ごと取り消してゴールドを返す
    purchases: (Array.isArray(r.purchases) ? r.purchases : []).filter(p => !RETIRED_ITEMS.has(p.item)),
    freezes: r.freezes && typeof r.freezes === "object" ? r.freezes : {},
    owned: (Array.isArray(r.owned) ? r.owned : []).filter(id => !RETIRED_ITEMS.has(id)),
    equipped: { title: r.equipped?.title || null, bg: r.equipped?.bg || null },
    quests: { claimed: { ...(r.quests?.claimed || {}) } },
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
  { id: "t_steady", kind: "title", name: "コツコツの達人", icon: "📜", price: 300, desc: "称号" },
  { id: "t_iron", kind: "title", name: "鋼の意志", icon: "📜", price: 800, desc: "称号" },
  { id: "t_sage", kind: "title", name: "習慣の賢者", icon: "📜", price: 2000, desc: "称号" },
  { id: "t_legend", kind: "title", name: "伝説の継続者", icon: "📜", price: 5000, desc: "称号" },
  { id: "bg_meadow", kind: "bg", name: "草原", icon: "🌿", price: 400, desc: "背景",
    css: "radial-gradient(ellipse at 15% 110%,#4f8a5a66,transparent 65%),linear-gradient(160deg,#1a231c,#111614)" },
  { id: "bg_dusk", kind: "bg", name: "夕焼け", icon: "🌇", price: 700, desc: "背景",
    css: "radial-gradient(ellipse at 85% 0,#d9825466,transparent 65%),linear-gradient(170deg,#2a1c1e,#14111a)" },
  { id: "bg_night", kind: "bg", name: "星空", icon: "🌌", price: 1200, desc: "背景",
    css: "radial-gradient(1px 1px at 20% 30%,#fff9,transparent),radial-gradient(1px 1px at 70% 20%,#fff8,transparent),radial-gradient(1.5px 1.5px at 85% 60%,#fffa,transparent),radial-gradient(1px 1px at 40% 75%,#fff7,transparent),linear-gradient(170deg,#141a33,#0b0d18)" },
  { id: "bg_castle", kind: "bg", name: "王城", icon: "🏰", price: 2500, desc: "背景",
    css: "radial-gradient(ellipse at 50% 0,#dfbd7c55,transparent 60%),linear-gradient(170deg,#2a2338,#16131d)" },
  // クエスト報酬でしか手に入らないもの(quest-core.mjs の QUEST_LINES が配る)
  { id: "t_iron_body", kind: "title", name: "鋼の肉体", icon: "📜", quest: true, desc: "クエスト報酬" },
  { id: "t_scholar", kind: "title", name: "知の探究者", icon: "📜", quest: true, desc: "クエスト報酬" },
  { id: "t_traveler", kind: "title", name: "一年の冒険者", icon: "📜", quest: true, desc: "クエスト報酬" },
  { id: "t_collector", kind: "title", name: "メダルコレクター", icon: "📜", quest: true, desc: "クエスト報酬" },
  { id: "t_legs", kind: "title", name: "健脚の旅人", icon: "📜", quest: true, desc: "クエスト報酬" },
  { id: "t_linguist", kind: "title", name: "ことばの使い手", icon: "📜", quest: true, desc: "クエスト報酬" },
  { id: "t_stacker", kind: "title", name: "積み重ねの人", icon: "📜", quest: true, desc: "クエスト報酬" },
  { id: "bg_kitchen", kind: "bg", name: "灯りの台所", icon: "🍲", quest: true, desc: "クエスト報酬",
    css: "radial-gradient(ellipse at 80% 100%,#e0954a55,transparent 60%),linear-gradient(165deg,#2a2018,#15110e)" },
  { id: "bg_hall", kind: "bg", name: "音楽堂", icon: "🎻", quest: true, desc: "クエスト報酬",
    css: "radial-gradient(ellipse at 50% 0,#f0d7a333,transparent 55%),linear-gradient(90deg,#3a1418,#1c1013 28%,#1c1013 72%,#3a1418)" },
  { id: "bg_dawn", kind: "bg", name: "夜明け", icon: "🌅", quest: true, desc: "クエスト報酬",
    css: "radial-gradient(ellipse at 50% 115%,#f2b36a66,transparent 60%),linear-gradient(180deg,#1b2238,#2a2232 70%,#3a2a2a)" },
];
export const SHOP_KINDS = [
  { kind: "shield", label: "どうぐ" }, { kind: "title", label: "称号" }, { kind: "bg", label: "背景" },
];
// 休止中のアイテム(おとも)。保存データに残っていても読み込み時に取り除く
export const RETIRED_ITEMS = new Set(["p_chick", "p_cat", "p_owl", "p_fox", "p_dragon",
  "p_kangaroo", "p_parrot", "p_bird", "p_turtle"]);
export function shopItem(id) { return SHOP.find(i => i.id === id) || null; }
export function purchase(r, itemId, today) {
  const it = shopItem(itemId);
  if (!it) return { ok: false, reason: "unknown" };
  if (it.quest) return { ok: false, reason: "quest" };
  if (it.kind !== "shield" && r.owned.includes(it.id)) return { ok: false, reason: "owned" };
  if (it.kind === "shield" && shieldCount(r) >= SHIELD_MAX) return { ok: false, reason: "max" };
  if (balance(r) < it.price) return { ok: false, reason: "gold" };
  const n = clone(r);
  n.purchases.push({ item: it.id, price: it.price, on: today });
  if (it.kind !== "shield") { n.owned.push(it.id); n.equipped[it.kind] = it.id; }
  return { ok: true, state: n };
}
export function equip(r, kind, itemId) {
  if (!(kind in r.equipped)) return r;
  if (itemId && !r.owned.includes(itemId)) return r;
  const n = clone(r);
  n.equipped[kind] = itemId || null;
  return n;
}

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
  if (h.goal.type === "count") return h.link === "workout" ? "部位" : "回";
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
