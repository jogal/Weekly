// 達成度ごほうびの画面。tracker.html とは window.HeroReward だけでつながる(ロジックは hero-reward-core.mjs)。
//   decorate(box)   … 育成タブのアバター枠に、今日の達成度のエフェクトを重ねる
//   onZoomOpen(ov)  … 拡大画面にセリフとタップ反応、全達成の日はごほうびカットのボタンを足す
import * as R from "./hero-reward-core.mjs";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const readSetting = () => { try { return JSON.parse(localStorage.getItem(R.KEY)); } catch { return null; } };
const enabled = () => R.isOn(readSetting());

function progress() {
  const p = window.HabitUI?.todayProgress?.();
  if (!p) return null;
  return { ...p, stage: R.stageOf(p) };
}

const FX = [
  '<span class="hr-zz">z<i>z</i></span>',
  "",
  '<span class="hr-drop d1"></span><span class="hr-drop d2"></span>',
  '<span class="hr-glow"></span><span class="hr-spark s1">✦</span><span class="hr-spark s2">✧</span><span class="hr-spark s3">✦</span>',
];

function paint(host, stage) {
  host.classList.remove("hr-s0", "hr-s1", "hr-s2", "hr-s3");
  host.querySelector(":scope > .hr-fx")?.remove();
  if (stage == null) return;
  host.classList.add("hr-s" + stage);
  const fx = document.createElement("span");
  fx.className = "hr-fx";
  fx.setAttribute("aria-hidden", "true");
  fx.innerHTML = FX[stage];
  host.appendChild(fx);
}

function decorate(box) {
  if (!box) return;
  const p = enabled() ? progress() : null;
  paint(box, p ? p.stage : null);
  if (p) box.title = `今日 ${p.done}/${p.due} ・ ${R.STAGES[p.stage].name}`;
}

let tap = 0;
function onZoomOpen(ov) {
  ov.querySelectorAll(".hr-keep").forEach(e => e.remove());
  const clip = ov.querySelector(".hero-sprite-clip");
  const hint = ov.querySelector(".hero-zoom-hint");
  const p = enabled() ? progress() : null;
  paint(clip, p ? p.stage : null);
  clip.classList.toggle("hr-tappable", !!p);
  clip.onclick = null;
  if (hint) hint.textContent = p ? "キャラをタップで反応 ・ まわりをタップで閉じる" : "タップで閉じる";
  if (!p) return;

  tap = Math.floor(Math.random() * 3);
  const bubble = document.createElement("div");
  bubble.className = "hr-bubble hr-keep";
  bubble.setAttribute("role", "status");
  ov.insertBefore(bubble, clip);
  const meter = document.createElement("div");
  meter.className = "hr-meter hr-keep";
  meter.innerHTML = `<span>今日 ${p.done}/${p.due}</span><b>${esc(R.STAGES[p.stage].name)}</b>`;
  ov.insertBefore(meter, clip.nextSibling);

  const say = animate => {
    const l = R.lineFor(p.stage, tap, p.doneNames || []);
    bubble.textContent = `「${l.text}」`;
    if (!animate) return;
    clip.classList.remove("hr-move-yawn", "hr-move-hop", "hr-move-sway", "hr-move-flex");
    void clip.offsetWidth;
    clip.classList.add("hr-move-" + l.move);
  };
  say(false);
  clip.onclick = e => { e.stopPropagation(); tap++; say(true); };

  if (p.stage === 3) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hr-cut-btn hr-keep";
    b.textContent = "🎁 今日のごほうびカットを見る";
    b.onclick = e => { e.stopPropagation(); openCut(p.today, ov.querySelector("img")?.src); };
    hint ? ov.insertBefore(b, hint) : ov.appendChild(b);
  }
}

function openCut(day, heroSrc) {
  const cut = R.cutOfDay(day);
  let ov = document.getElementById("hr-cut");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "hr-cut";
    ov.className = "overlay";
    ov.addEventListener("click", () => { ov.style.display = "none"; });
    document.body.appendChild(ov);
  }
  ov.innerHTML = `<div class="hr-cut-card">
      <div class="hr-cut-art"><img alt="${esc(cut.title)}"></div>
      <div class="hr-cut-title">✨ ${esc(cut.title)}</div>
      <div class="hr-cut-line">「${esc(cut.line)}」</div>
      <div class="hr-cut-note">全部こなした日だけのごほうび ・ タップで閉じる</div>
    </div>`;
  const art = ov.querySelector(".hr-cut-art");
  const img = art.querySelector("img");
  img.onerror = () => {
    // 絵がまだ無いときの仮の画面: 今のアバターに「仕上がった」のエフェクトを重ねる
    art.classList.add("hr-cut-ph");
    art.innerHTML = `<span class="hero-sprite-clip hr-s3"><img class="hero-sprite" alt=""></span>
      <span class="hr-cut-soon">絵は準備中（sprites/reward/${esc(cut.id)}.png）</span>`;
    const clip = art.querySelector(".hero-sprite-clip");
    paint(clip, 3);
    const hi = clip.querySelector("img");
    hi.onload = () => window.sizeHeroSprite?.(hi);
    if (heroSrc) hi.src = heroSrc;
  };
  img.src = `sprites/reward/${cut.id}.png`;
  ov.style.display = "flex";
}

// 設定メニューに ON/OFF を足す
function mountSetting() {
  const menu = document.getElementById("menu-modal");
  const anchor = document.getElementById("export-btn");
  if (!menu || !anchor || document.getElementById("hr-toggle")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "menu-item";
  b.id = "hr-toggle";
  const label = () => { b.textContent = `✨ 達成度ごほうび：${enabled() ? "ON" : "OFF"}`; };
  label();
  b.onclick = () => {
    const off = enabled();
    localStorage.setItem(R.KEY, JSON.stringify({ off }));
    label();
    window.showToast?.(off ? "達成度ごほうびをOFFにしました" : "✨ 達成度ごほうびをONにしました");
    if (typeof window.render === "function") window.render();
  };
  anchor.parentNode.insertBefore(b, anchor);
}

window.HeroReward = { decorate, onZoomOpen, openCut };
mountSetting();
// 育成タブが先に描かれていたら、ここで重ね直す
document.querySelectorAll(".hero-compact .hero-sprite-box").forEach(decorate);
