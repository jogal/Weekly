// Display-only companion. No training, XP, or localStorage writes.
const TIERS = [1, 10, 20, 30, 40];
const SEQUENCES = {
  punch: [[0, 'guard'], [200, 'punch'], [520, 'guard'], [800, 'idle']],
  flex: [[0, 'guard'], [220, 'flex'], [1500, 'guard'], [1760, 'idle']],
};

export function createMonkCompanion() {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let actor = null, observer = null, visible = false, ready = false;
  let idleTimer = null, frameTimers = [], busy = false, lastPlayed = -Infinity;
  let nextAction = 'punch', celebrationUntil = 0, away = false;
  const assets = new Map();

  function awake() {
    return actor?.isConnected && visible && !document.hidden && !away && !motion.matches;
  }
  function eligible() { return awake() && ready; }
  function clearTimers() {
    clearTimeout(idleTimer); idleTimer = null;
    frameTimers.forEach(clearTimeout); frameTimers = [];
    busy = false;
    if (actor) actor.dataset.pose = 'idle';
  }
  function schedule() {
    clearTimeout(idleTimer);
    if (!eligible() || busy) return;
    idleTimer = setTimeout(() => {
      if (!play(nextAction)) schedule();
    }, 18000 + Math.random() * 14000);
  }
  function play(kind) {
    if (!eligible() || busy || Date.now() - lastPlayed < 2800) return false;
    // Keep attention on the form or modal while the user is entering a record.
    if (document.activeElement?.matches('input,textarea,select,[contenteditable="true"]') ||
        [...document.querySelectorAll('.overlay')].some(e => e.getClientRects().length)) return false;
    clearTimers(); busy = true; lastPlayed = Date.now();
    nextAction = kind === 'punch' ? 'flex' : 'punch';
    actor.dataset.action = kind;
    for (const [delay, pose] of SEQUENCES[kind]) {
      frameTimers.push(setTimeout(() => {
        if (!eligible()) { sync(); return; }
        actor.dataset.pose = pose;
        if (pose === 'idle') { busy = false; frameTimers = []; schedule(); }
      }, delay));
    }
    return true;
  }
  function sync() {
    if (!actor) return;
    actor.dataset.paused = String(!awake());
    actor.disabled = !ready || motion.matches;
    if (!eligible()) { clearTimers(); return; }
    if (celebrationUntil > Date.now()) {
      celebrationUntil = 0;
      if (play('flex')) return;
    }
    if (!busy) schedule();
  }
  function tap() { play(nextAction); }
  function detach() {
    clearTimers(); observer?.disconnect(); observer = null;
    actor?.removeEventListener('click', tap);
    if (actor) actor.dataset.paused = 'true';
    actor = null; visible = false; ready = false; celebrationUntil = 0;
  }
  function attach(button, tier, celebrate = false) {
    detach(); actor = button;
    actor.dataset.pose = 'idle'; actor.dataset.paused = 'true'; actor.disabled = true;
    if (!TIERS.includes(tier)) return; // A legacy fallback stays idle, in its own outfit.
    const target = actor;
    celebrationUntil = celebrate ? Date.now() + 5000 : 0;
    target.addEventListener('click', tap);
    observer = new IntersectionObserver(entries => {
      visible = entries.some(e => e.isIntersecting && e.intersectionRatio >= 0.6);
      sync();
    }, {threshold: [0, 0.6, 1]});
    observer.observe(target);
    if (!assets.has(tier)) {
      assets.set(tier, new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => { assets.delete(tier); resolve(null); };
        img.src = `sprites/monk-actions/lv${tier}.webp`;
      }));
    }
    assets.get(tier).then(img => {
      if (actor !== target || !target.isConnected) return;
      if (!img) { sync(); return; }
      target.style.setProperty('--action-sheet', `url("${img.src}")`);
      ready = true; sync();
    });
  }
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);
  window.addEventListener('pagehide', () => { away = true; sync(); });
  window.addEventListener('pageshow', () => { away = false; sync(); });
  document.addEventListener('focusin', e => {
    if (e.target.matches('input,textarea,select,[contenteditable="true"]')) { clearTimers(); schedule(); }
  });
  return {attach, detach};
}
