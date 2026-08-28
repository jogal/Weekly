// Vercel Serverless Function: AI Coach プロキシ
// - OPENAI_API_KEY / OPENAI_MODEL はサーバ環境変数のみ(ブラウザに置かない)
// - OpenAI Responses API + Structured Outputs(JSON Schema, strict)
// - AIは計算主体ではなく、rule-based engineの結果を短い日本語で説明する役割
// - レスポンスは必ずvalidateしてから返す。失敗時はfrontendがrule-basedのみで動く
// - 任意のCOACH_TOKENを設定すると Authorization: Bearer <token> を要求する

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "workoutAdvice", "exerciseAdvice", "nutritionAdvice", "caution"],
  properties: {
    headline: { type: "string" },
    workoutAdvice: { type: "string" },
    exerciseAdvice: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["exercise", "advice"],
        properties: {
          exercise: { type: "string" },
          advice: { type: "string" },
        },
      },
    },
    nutritionAdvice: { type: ["string", "null"] },
    caution: { type: ["string", "null"] },
  },
};

const INSTRUCTIONS = [
  "あなたは筋肥大を支援するパーソナルトレーニングコーチです。",
  "入力はアプリのrule-based engineが計算済みの結果(次回ターゲット・週間プラン・体重/タンパク質トレンド)です。",
  "あなたの役割は計算や数値の再決定ではなく、結果を短い日本語で説明・補足することです。",
  "文体: 簡潔。挨拶や前置きなし。最大でも数段落。絵文字は使わない。",
  "優先部位(deltoids側部/上胸/三頭/広背筋/二頭/脚/腹筋の順)を意識した一言があると良い。",
  "医療診断・治療助言はしない。痛みの報告があれば無理をしない方向の短い注意のみ。",
  "engineのターゲット数値と矛盾する指示を出さない。",
].join("\n");

function validateCoachJson(o) {
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

function buildOpenAIRequest(payload, model) {
  return {
    model,
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content: JSON.stringify(payload) }],
    max_output_tokens: 700,
    text: {
      format: {
        type: "json_schema",
        name: "coach_advice",
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
  };
}

// Responses APIの出力からテキストを取り出す(output_text/messageの双方に対応)
function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const c of item.content || []) {
      if (c.type === "output_text" && typeof c.text === "string") return c.text;
    }
  }
  return null;
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
  if (process.env.COACH_TOKEN) {
    const auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + process.env.COACH_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "invalid payload" });
  }
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(buildOpenAIRequest(payload, model)),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(502).json({ error: "openai " + r.status, detail: detail.slice(0, 300) });
    }
    const data = await r.json();
    const text = extractOutputText(data);
    let advice = null;
    try { advice = JSON.parse(text); } catch (e) { /* fallthrough */ }
    if (!validateCoachJson(advice)) {
      return res.status(502).json({ error: "invalid model output" });
    }
    return res.status(200).json({ advice });
  } catch (e) {
    return res.status(502).json({ error: "upstream failure" });
  }
}

module.exports = handler;
// テスト用に内部関数も公開
module.exports.validateCoachJson = validateCoachJson;
module.exports.buildOpenAIRequest = buildOpenAIRequest;
module.exports.extractOutputText = extractOutputText;
