// 達成度ごほうび(ロジックだけ)。育成タブのアバターに、その日の習慣の達成度で
// エフェクト・タップの反応・全達成の日の「ごほうびカット」を足す。
// レベルごとの絵(ジョブ × レベル帯)には一切さわらない。ゴールドや経験値も動かさない。

export const KEY = "wt_hero_reward_v1"; // { off: true } のときだけ止める(端末ごとの表示設定)

// 0 = だらっと(0件) / 1 = エンジンがかかる(1件〜) / 2 = 温まってきた(半分〜) / 3 = 仕上がった(全部)
export const STAGES = [
  { id: "idle", name: "だらっと" },
  { id: "warm", name: "エンジンがかかってきた" },
  { id: "hot", name: "温まってきた" },
  { id: "peak", name: "仕上がった" },
];

export function stageOf({ due = 0, done = 0 } = {}) {
  if (done <= 0) return 0;
  if (due > 0 && done >= due) return 3;
  if (done * 2 >= due) return 2;
  return 1;
}

// タップするたびに順番に出す。{name} は今日できた習慣の名前に置き換える
export const LINES = [
  [
    { text: "……ん、まだ眠い。1個やったら起きる", move: "yawn" },
    { text: "今日はまだ何もしてないだろ。1個だけでいい、行ってこい", move: "yawn" },
    { text: "そんなに見ても、何も出ないぞ。……今はな", move: "yawn" },
  ],
  [
    { text: "よし、動けてるな。次いくぞ", move: "hop" },
    { text: "「{name}」、見てたぞ。その調子", move: "hop" },
    { text: "体が温まってきた。もう少し付き合え", move: "hop" },
  ],
  [
    { text: "暑くなってきた。……見るなよ、前開けるから", move: "sway" },
    { text: "あと少しだな。汗、拭いてくれてもいいんだぞ", move: "sway" },
    { text: "「{name}」まで片付けたか。……悪くない顔してる", move: "sway" },
  ],
  [
    { text: "全部やったな。……今日の俺、どうだ？", move: "flex" },
    { text: "見てたよ、ちゃんと。今日は好きなだけ見てていい", move: "flex" },
    { text: "ここまで仕上がる日は、そうない。目に焼き付けとけ", move: "flex" },
  ],
];

export function lineFor(stage, tap = 0, doneNames = []) {
  const list = LINES[Math.max(0, Math.min(3, stage))];
  const usable = doneNames.length ? list : list.filter(l => !l.text.includes("{name}"));
  const l = usable[((tap % usable.length) + usable.length) % usable.length];
  const name = doneNames.length ? doneNames[tap % doneNames.length] : "";
  return { text: l.text.replaceAll("{name}", name), move: l.move };
}

// 全部こなした日だけ見られる一枚絵。日付で1枚決まる(同じ日は何度開いても同じ)。
// 絵は sprites/reward/<id>.png(tools/make_reward_cuts.py がモンクの絵から作る)。無ければ仮の画面になる。
export const CUTS = [
  { id: "pump", title: "パンプアップ", line: "仕上がったところ、一番に見せたかった" },
  { id: "bath", title: "湯けむり", line: "……ノックくらいしろよ。まあ、今日はいいか" },
  { id: "jazz", title: "深夜のジャズバー", line: "今日頑張ったお前に、一杯おごってやる。隣、空いてるぞ" },
  { id: "dawn", title: "夜明けの拳", line: "汗だくだな、お互い。いい朝だ" },
  { id: "festival", title: "夏祭りの夜", line: "花火より、こっち見てたろ。……別にいいけど" },
  { id: "beach", title: "海辺の夕暮れ", line: "ここまで来たご褒美。少しだけ、隣にいろ" },
];

export function cutOfDay(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CUTS[h % CUTS.length];
}

export function isOn(raw) { return !(raw && raw.off === true); }
