// ai-coach.mjs — AI Coachクライアント層
// - AIはoptional enhancement: endpoint未設定/失敗でもアプリはrule-basedのみで正常動作
// - GCalの生タイトルは絶対に含めない(呼び出し側もderived constraintsだけ渡す)
// - サーバ(api/coach.js)がOpenAIを呼ぶ。ブラウザにAPIキーは存在しない

// 送信payloadの組み立て(pure)。渡された素材をそのまま整形するだけで、
// localStorageやDOMには触れない
export function buildCoachPayload({
  profile, latestWeight, weightTrend, protein,
  recentSessions, nextWorkout, nextTargets, weeklyPlan, dayConstraints, painFlags,
}) {
  return {
    goal: {
      heightCm: profile.heightCm,
      currentWeightKg: latestWeight,
      targetWeightKg: profile.targetWeightKg,
      phase: "hypertrophy (lean bulk)",
      paceGuideline: "0.1-0.25% bodyweight/week",
      priorityMuscles: ["三角筋側部", "上胸", "上腕三頭筋", "広背筋", "上腕二頭筋", "脚", "腹筋"],
    },
    weightTrend: weightTrend ? {
      status: weightTrend.status, avg7: weightTrend.avg7, perWeekKg: weightTrend.perWeek,
    } : null,
    protein: protein || null,
    recentSessions: recentSessions || [],
    nextWorkout: nextWorkout || null,
    nextTargets: nextTargets || [],
    weeklyPlan: weeklyPlan || null,
    dayConstraints: dayConstraints || [],   // 例 "水: blocked(当直/勤務ブロック)" 派生情報のみ
    painFlags: painFlags || [],
  };
}

// サーバ応答のschema検証。サーバ側validateCoachJsonと完全に同一条件
// (nutritionAdvice/cautionはrequired: string|nullで、undefinedは不可)。
// parityはtests/ai-coach.test.mjsの共通fixtureで担保する
export function validateCoachResponse(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  if (typeof o.headline !== "string" || typeof o.workoutAdvice !== "string") return false;
  if (!Array.isArray(o.exerciseAdvice)) return false;
  for (const e of o.exerciseAdvice) {
    if (!e || typeof e.exercise !== "string" || typeof e.advice !== "string") return false;
  }
  if (o.nutritionAdvice !== null && typeof o.nutritionAdvice !== "string") return false;
  if (o.caution !== null && typeof o.caution !== "string") return false;
  return true;
}

export function coachFingerprint(payload) {
  const s = JSON.stringify(payload);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

export async function requestCoach(endpoint, payload, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(endpoint, {
    method: "POST", headers, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("coach " + r.status);
  const data = await r.json();
  if (!validateCoachResponse(data.advice)) throw new Error("invalid coach response");
  return data.advice;
}
