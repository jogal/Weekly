// quest-core.mjs — クエスト掲示板(積み上げ型クエスト)の純粋ロジック。
// 進捗はすべて既存の記録(wt_records・wt_habit_log_v1・メダル)から毎回数え直す。
// 保存するのは「どのクエストを受け取ったか」だけ(wt_reward_v1.quests.claimed)。
// 連続記録と違って途切れても減らないので、休んだあとに戻る理由になる。
import * as H from "./habit-core.mjs";

export const ROMAN = ["I", "II", "III", "IV", "V"];
const MAX_HISTORY_DAYS = 3650;

// metric:
//   track:<id>   その記録を完了した日数(筋トレは部位をまとめて1日)
//   part:<id>    筋トレのその部位を完了した日数
//   minutes:<id> 完了した記録の累計分
//   habit:<id>   自分で追加した習慣の目標を達成した日数
//   activeDays / habitTotal / perfectDays / medals
export const QUEST_LINES = [
  { id: "workout_days", icon: "💪", name: "鍛錬の道", metric: "track:workout", unit: "日", desc: "筋トレを{n}",
    tiers: [{ n: 10, g: 50 }, { n: 30, g: 150 }, { n: 100, g: 500 }, { n: 300, g: 1500 }] },
  { id: "leg_days", icon: "🦵", name: "脚の日", metric: "part:leg", unit: "日", desc: "脚を{n}鍛える",
    tiers: [{ n: 5, g: 40 }, { n: 20, g: 120 }, { n: 60, g: 400 }] },
  { id: "medicine_hours", icon: "🧠", name: "知識の泉", metric: "minutes:medicine", unit: "時間", desc: "専門医勉強を累計{n}",
    tiers: [{ n: 600, g: 60 }, { n: 3000, g: 200 }, { n: 9000, g: 600 }, { n: 30000, g: 2000 }] },
  { id: "english_hours", icon: "🌐", name: "ことばの旅", metric: "minutes:english", unit: "時間", desc: "英語学習を累計{n}",
    tiers: [{ n: 600, g: 60 }, { n: 1800, g: 150 }, { n: 6000, g: 500 }, { n: 18000, g: 1500 }] },
  { id: "instrument_days", icon: "🎵", name: "音色を磨く", metric: "track:instrument", unit: "日", desc: "楽器を{n}練習する",
    tiers: [{ n: 10, g: 50 }, { n: 30, g: 150 }, { n: 100, g: 500 }, { n: 300, g: 1500 }] },
  { id: "cooking_days", icon: "🍳", name: "台所の主", metric: "track:cooking", unit: "日", desc: "自炊を{n}",
    tiers: [{ n: 10, g: 50 }, { n: 50, g: 200 }, { n: 150, g: 600 }, { n: 365, g: 1500 }] },
  { id: "active_days", icon: "🗺️", name: "冒険の日々", metric: "activeDays", unit: "日", desc: "何かひとつ達成した日を{n}",
    tiers: [{ n: 30, g: 100 }, { n: 100, g: 300 }, { n: 365, g: 1000 }] },
  { id: "habit_total", icon: "📚", name: "積み重ね", metric: "habitTotal", unit: "回", desc: "習慣の目標を合計{n}達成",
    tiers: [{ n: 50, g: 80 }, { n: 200, g: 250 }, { n: 1000, g: 1000 }] },
  { id: "perfect_days", icon: "🌟", name: "パーフェクトデイ", metric: "perfectDays", unit: "日", desc: "予定の習慣をすべて達成した日を{n}",
    tiers: [{ n: 3, g: 80 }, { n: 10, g: 200 }, { n: 50, g: 800 }] },
  { id: "medals", icon: "🏅", name: "メダルコレクター", metric: "medals", unit: "個", desc: "連続記録のメダルを{n}集める",
    tiers: [{ n: 1, g: 50 }, { n: 3, g: 150 }, { n: 10, g: 600 }] },
];
// 自分で追加した習慣には、それぞれ専用のクエストが付く
export const HABIT_TIERS = [{ n: 7, g: 40 }, { n: 30, g: 120 }, { n: 100, g: 400 }, { n: 365, g: 1200 }];

export function questLines(habits = []) {
  const own = habits.filter(h => !h.link && !h.archived).map(h => ({
    id: "habit_" + h.id, icon: h.icon, name: h.name, metric: "habit:" + h.id, unit: "日",
    desc: `「${h.name}」を{n}達成`, tiers: HABIT_TIERS, custom: true,
  }));
  return [...QUEST_LINES, ...own];
}
export function questId(line, tierIdx) { return `${line.id}:${tierIdx}`; }

// ── 進捗の集計(記録から毎回数える) ────────────────────────────────────────
export function questMetrics({ records = {}, log = {}, habits = [], reward = null, today }) {
  const m = { track: {}, part: {}, minutes: {}, habit: {}, activeDays: 0, habitTotal: 0, perfectDays: 0, medals: 0 };
  const active = new Set(), trackDays = {}, partDays = {};
  for (const wk of Object.keys(records)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wk)) continue;
    H.DAY_KEYS.forEach((dk, i) => {
      const day = records[wk]?.[dk];
      if (!day) return;
      const key = H.addDays(wk, i);
      if (key > today) return;
      for (const [cat, r] of Object.entries(day)) {
        if (!r?.done) continue;
        active.add(key);
        const isWorkout = cat.startsWith("workout_");
        (trackDays[isWorkout ? "workout" : cat] ||= new Set()).add(key);
        if (isWorkout) (partDays[cat.slice(8)] ||= new Set()).add(key);
        m.minutes[cat] = (m.minutes[cat] || 0) + (parseInt(r.duration, 10) || 0);
      }
    });
  }
  const ctx = { records, log, freezes: reward?.freezes || {}, today };
  ctx.floorKey = H.dataFloor(records, log);
  let from = ctx.floorKey;
  if (from) {
    const oldest = H.addDays(today, -MAX_HISTORY_DAYS);
    if (from < oldest) from = oldest;
    for (let k = from; k <= today; k = H.addDays(k, 1)) {
      let any = false;
      for (const h of habits) {
        if (!H.isActiveOn(h, k) || !H.isAchieved(h, k, ctx)) continue;
        m.habitTotal++; any = true;
        if (!h.link) m.habit[h.id] = (m.habit[h.id] || 0) + 1;
      }
      if (any) active.add(k);
      if (H.perfectGold(habits, k, ctx) > 0) m.perfectDays++;
    }
  }
  Object.entries(trackDays).forEach(([k, set]) => { m.track[k] = set.size; });
  Object.entries(partDays).forEach(([k, set]) => { m.part[k] = set.size; });
  m.activeDays = active.size;
  m.medals = reward ? H.medals(reward).length : 0;
  return m;
}
export function metricValue(line, m) {
  const [kind, arg] = line.metric.split(":");
  if (arg !== undefined) return m[kind]?.[arg] || 0;
  return m[kind] || 0;
}

// ── 掲示板 ───────────────────────────────────────────────────────────────────
// 各ラインは受け取った段階の次が「いまのクエスト」。全段階を受け取ると制覇
export function questBoard(m, reward, habits = []) {
  const claimed = reward?.quests?.claimed || {};
  return questLines(habits).map(line => {
    let t = 0;
    while (t < line.tiers.length && claimed[questId(line, t)]) t++;
    const done = t >= line.tiers.length;
    const tier = line.tiers[Math.min(t, line.tiers.length - 1)];
    const value = metricValue(line, m);
    return {
      line, tierIdx: t, done, value, target: tier.n, reward: tier,
      id: done ? null : questId(line, t),
      title: `${line.name} ${ROMAN[Math.min(t, line.tiers.length - 1)]}`,
      claimable: !done && value >= tier.n,
      ratio: done ? 1 : Math.min(1, value / tier.n),
    };
  });
}
export function claimableQuests(board) { return board.filter(q => q.claimable); }
// 今日タブに出す「あと少し」のクエスト: 受け取り前で、いちばん進んでいるもの
export function nearestQuest(board) {
  return board.filter(q => !q.done && !q.claimable && q.value > 0)
    .sort((a, b) => b.ratio - a.ratio || a.target - b.target)[0] || null;
}

export function claimQuest(reward, board, id, today) {
  const q = board.find(x => x.id === id);
  if (!q) return { ok: false, reason: "unknown" };
  if (reward?.quests?.claimed?.[id]) return { ok: false, reason: "claimed" };
  if (!q.claimable) return { ok: false, reason: "locked" };
  const r = JSON.parse(JSON.stringify(reward));
  r.quests = { claimed: { ...(r.quests?.claimed || {}), [id]: today } };
  r.grants.push({ g: q.reward.g, reason: "quest:" + id, on: today });
  return { ok: true, state: r, gold: q.reward.g };
}

// ── 表示用 ───────────────────────────────────────────────────────────────────
function fmtAmount(unit, v) {
  if (unit === "時間") {
    const h = v / 60;
    return (h >= 10 || Number.isInteger(h) ? Math.floor(h) : Math.floor(h * 10) / 10).toLocaleString("ja-JP");
  }
  return v.toLocaleString("ja-JP");
}
export function questDesc(q) {
  return q.line.desc.replace("{n}", fmtAmount(q.line.unit, q.target) + q.line.unit);
}
export function progressText(q) {
  return `${fmtAmount(q.line.unit, q.value)}/${fmtAmount(q.line.unit, q.target)}${q.line.unit}`;
}
export function rewardText(q) {
  return `${q.reward.g}G`;
}
// 受け取り履歴(新しい順)
export function claimedHistory(reward, habits = []) {
  const lines = questLines(habits);
  const all = [...lines, ...habits.filter(h => !h.link && h.archived).map(h => ({ id: "habit_" + h.id, icon: h.icon, name: h.name, tiers: HABIT_TIERS }))];
  return Object.entries(reward?.quests?.claimed || {}).map(([id, on]) => {
    const [lineId, t] = id.split(":");
    const line = all.find(l => l.id === lineId);
    return line ? { id, on, icon: line.icon, title: `${line.name} ${ROMAN[Number(t)] || ""}`, tier: line.tiers[Number(t)] } : null;
  }).filter(Boolean).sort((a, b) => b.on.localeCompare(a.on) || b.id.localeCompare(a.id));
}
