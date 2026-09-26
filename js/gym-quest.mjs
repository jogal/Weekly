// Read-only presentation models. Logs and Weekly records remain the source of truth.
import { localDayKey, questExerciseProgress } from "./training-core.mjs";

export function questView(template, sets) {
  const progress = questExerciseProgress(template, sets.map(s => s.ex));
  const target = progress.target ?? progress.total;
  const complete = target > 0 && progress.done >= target;
  const stage = !complete ? "idle" : progress.done >= progress.total ? "full"
    : progress.done > target ? "bonus" : "main";
  const label = stage === "full" ? "FULL CLEAR" : stage === "bonus" ? "BONUS CLEAR"
    : stage === "main" ? "MAIN QUEST CLEAR" : `${progress.done} / ${target} CLEAR`;
  const note = complete ? "今日のMain Quest達成。ここで終えても、余力でもう少しでも。"
    : sets.length ? `今日は${progress.done}/${progress.total}。記録は残っています。`
    : `${progress.total}種目のうち${target}種目でクリア。順番は自由。`;
  return { ...progress, target, complete, stage, label, note };
}

export function trainingDays(logs, dates) {
  const week = new Set(dates);
  return new Set(logs.map(l => localDayKey(l.t)).filter(d => week.has(d)));
}

export function routeDay(info, hasLogs) {
  if (info.status === "done") return { state: "done", label: "CLEAR", detail: "Main Quest達成" };
  if (hasLogs) return { state: "logged", label: "LOGGED", detail: "記録あり" };
  if (info.status === "blocked") return { state: "blocked", label: "BLOCKED", detail: "予定を優先する日" };
  if (info.recommended) return { state: "quest", label: "QUEST", detail: "トレーニング候補日" };
  return { state: "rest", label: "REST", detail: "RECOVERY DAY" };
}

export function monkSpriteCandidates(tier) {
  return [40, 30, 20, 10, 1].filter(t => t <= tier)
    .map(t => `sprites/monk_lv${t}x2.png`).concat("sprites/monk.png");
}

// Re-evaluate today's credit after deleting a set. Older completed sessions are
// historical facts: never reinterpret them using a newly edited template.
export function creditedSessions(sessions, logs, program, today) {
  return sessions.filter(s => {
    if (s.status !== "completed") return false;
    if (s.date !== today) return true;
    const tpl = program.templates.find(t => t.id === s.templateId);
    if (!Number.isInteger(tpl?.minExercises)) return true;
    return questExerciseProgress(tpl, logs.filter(l => localDayKey(l.t) === today).map(l => l.ex)).complete;
  });
}
