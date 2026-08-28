// training-plan.mjs — 週間トレーニングプランのpure関数層
// DOM・localStorage・fetch禁止。node:testでテスト可能。

// ── 予定タイトルのrule-based分類(LLM不使用) ──────────────────────────────────
// hard  : その日はトレーニング不可(当直等)。明示キーワードのみ。曖昧ならblockしない
// soft  : 夜の付き合い等。夜トレの優先度を下げる
// medium: 勉強会・会議等。軽い減点
export const HARD_KEYWORDS   = /当直|宿直|夜勤|オンコール|on[\s-]?call/i;
export const SOFT_KEYWORDS   = /飲み会|会食|懇親会|飲み|宴会|party|dinner/i;
export const MEDIUM_KEYWORDS = /勉強会|講演|学会|セミナー|研修|conference|meeting|ミーティング|会議/i;

export function classifyEventTitle(title) {
  const t = String(title || "");
  if (HARD_KEYWORDS.test(t)) return "hard";
  if (SOFT_KEYWORDS.test(t)) return "soft";
  if (MEDIUM_KEYWORDS.test(t)) return "medium";
  return null;
}

const WD_JP = ["日", "月", "火", "水", "木", "金", "土"];
function wdOf(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

// イベントを{title, startMin, durMin}へ正規化。
// {start,end}のISO日時形式も許容し(Phase4 GCal)、日マタギ(overnight)も
// durationが正になるよう扱う。
export function normalizeEvent(e) {
  let startMin = e.startMin ?? null;
  let durMin = null;
  if (e.start) {
    const st = new Date(e.start);
    startMin = st.getHours() * 60 + st.getMinutes();
    if (e.end) durMin = Math.max(0, (new Date(e.end) - st) / 60000);
  } else if (e.startMin != null && e.endMin != null) {
    durMin = e.endMin >= e.startMin
      ? e.endMin - e.startMin
      : e.endMin + 1440 - e.startMin;   // overnight (22:00→06:00 等)
  }
  return { title: e.title, startMin, durMin };
}

// ── 週間プラン生成 ────────────────────────────────────────────────────────────
// dates: 週7日のlocal date key(月曜始まり) 例 ["2026-08-24",...]
// events: {dateKey: [{title, startMin?, endMin?}]}
// manualOverrides: {dateKey: "available"|"maybe"|"blocked"}  ※自動判定より常に優先
// completedSessions: 今週の完了 [{date, templateId}]
// nextWorkout: サイクル上の次テンプレートID
// 返り値: { recommendedDays:[{date,templateId}], sessions:同, reasons:[短文], dayInfo }
export function generateWeeklyTrainingPlan({
  dates, events = {}, manualOverrides = {}, completedSessions = [],
  nextWorkout = "A", targetSessions = 4, todayKey = null,
  defaultWednesdayBlocked = true, cycle = ["A", "B", "C", "D"],
}) {
  const doneByDate = {};
  completedSessions.forEach(s => { doneByDate[s.date] = s.templateId; });

  // ── 各日の状態とスコア ──
  const dayInfo = {};
  const reasons = [];
  dates.forEach(d => {
    const wd = wdOf(d);
    const ov = manualOverrides[d] || null;
    const evs = events[d] || [];
    const info = { date: d, status: "ok", score: 0, notes: [] };

    if (doneByDate[d] !== undefined) {
      info.status = "done"; info.templateId = doneByDate[d];
    } else if (todayKey && d < todayKey) {
      info.status = "past";
    } else if (ov === "blocked") {
      info.status = "blocked"; info.notes.push("手動ブロック");
    } else if (ov === "available") {
      // manual AVAILABLEは自動判定(水曜default・イベント減点)より常に優先
      info.score += 3; info.notes.push("手動で可");
    } else {
      const hard = evs.some(e => classifyEventTitle(e.title) === "hard");
      if (hard) {
        info.status = "blocked"; info.notes.push("当直/勤務ブロック");
      } else if (wd === 3 && defaultWednesdayBlocked) {
        info.status = "blocked"; info.notes.push("水曜(当直勤務があり得る日)");
      } else {
        if (ov === "maybe") { info.score -= 2; info.notes.push("△扱い"); }
        evs.map(normalizeEvent).forEach(e => {
          const c = classifyEventTitle(e.title);
          const evening = e.startMin != null && e.startMin >= 17 * 60;
          const long = e.durMin != null && e.durMin >= 6 * 60;
          if (c === "soft") { info.score -= evening ? 2 : 1; info.notes.push("夜の予定"); }
          else if (c === "medium") { info.score -= 1; info.notes.push("予定あり"); }
          if (long) { info.score -= 2; info.notes.push("長時間の予定"); }
        });
      }
    }
    dayInfo[d] = info;
  });

  // ── 候補日から最良の組み合わせを選ぶ ──
  const doneCount = Object.keys(doneByDate).length;
  const remaining = Math.max(0, targetSessions - doneCount);
  const eligible = dates.filter(d => dayInfo[d].status === "ok");
  const k = Math.min(remaining, eligible.length);

  let best = null;
  if (k > 0) {
    const idxOf = {}; dates.forEach((d, i) => idxOf[d] = i);
    // 完了済みセッションも同じ時系列に固定要素として置き、回復制約
    // (連続日数・D→Aの48h)を「完了済み↔提案」の境界にも適用する。
    // ただしsoft penalty: 他に候補がなければ許容される
    const fixed = dates
      .filter(d => dayInfo[d].status === "done")
      .map(d => ({ i: idxOf[d], templateId: doneByDate[d] }));
    for (const combo of combos(eligible, k)) {
      const days = combo.slice().sort();
      // サイクル順にテンプレートを割り当て(スキップしない)
      const start = Math.max(0, cycle.indexOf(nextWorkout));
      const assign = days.map((d, j) => ({ date: d, templateId: cycle[(start + j) % cycle.length] }));
      let score = days.reduce((a, d) => a + dayInfo[d].score, 0);
      // 完了済み+提案を時系列マージしてパターンを評価
      const seq = [...fixed, ...assign.map(a => ({ i: idxOf[a.date], templateId: a.templateId }))]
        .sort((a, b) => a.i - b.i);
      // 連続日数ペナルティ: 3連続以降は1日ごとに-3。隣接自体は軽く-0.5
      let run = 1;
      for (let j = 1; j < seq.length; j++) {
        if (seq[j].i === seq[j - 1].i + 1) {
          run++; score -= 0.5;
          if (run >= 3) score -= 3;
        } else run = 1;
      }
      // D→Aの連日は可能なら避ける(48h空ける)
      for (let j = 1; j < seq.length; j++) {
        if (seq[j].i === seq[j - 1].i + 1 &&
            seq[j - 1].templateId === "D" && seq[j].templateId === "A") score -= 2;
      }
      if (!best || score > best.score) best = { score, assign };
    }
  }
  const recommendedDays = best ? best.assign : [];

  // ── 理由(短文) ──
  dates.forEach(d => {
    const info = dayInfo[d];
    if (info.status === "blocked" || (info.notes.length && info.score < 0)) {
      reasons.push(`${WD_JP[wdOf(d)]}曜: ${info.notes[0]}`);
    }
  });
  if (recommendedDays.length) {
    reasons.push(recommendedDays.map(r => `${WD_JP[wdOf(r.date)]}(${r.templateId})`).join("・") + " を推奨");
  } else if (remaining === 0) {
    reasons.push(`今週の目標${targetSessions}回は達成済み`);
  } else {
    reasons.push("今週は空いている日がありません");
  }

  recommendedDays.forEach(r => {
    dayInfo[r.date].recommended = true;
    dayInfo[r.date].templateId = r.templateId;
  });
  return { recommendedDays, sessions: recommendedDays, reasons, dayInfo, remaining };
}

function* combos(arr, k) {
  if (k === 0) { yield []; return; }
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of combos(arr.slice(i + 1), k - 1)) {
      yield [arr[i], ...rest];
    }
  }
}
