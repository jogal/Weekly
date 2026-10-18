// pwa-update.js — Service Worker の登録と、新しい版の反映(4画面共通)。
// iPhoneのホーム画面アプリは、開き直しても前のページを再開するだけで読み込み直さないことがある。
// 画面に戻るたびに更新を確認し、新しい版が有効になったら、入力中でなければ読み込み直す。
(function () {
  if (!("serviceWorker" in navigator)) return;
  // 本番(https)だけで動かす。手元の確認では localStorage の wq_sw_dev=1 で有効にできる
  let devOptIn = false;
  try { devOptIn = localStorage.getItem("wq_sw_dev") === "1"; } catch (e) { /* storage unavailable */ }
  if (location.protocol !== "https:" && !devOptIn) return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;   // 初めて入れた時は読み込み直さない
  let pending = false, reloading = false;
  const busy = () =>
    [...document.querySelectorAll(".overlay")].some(o => getComputedStyle(o).display !== "none")
    || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  const reloadIfSafe = () => {
    if (!pending || reloading || document.hidden || busy()) return;
    reloading = true;
    location.reload();
  };
  sw.register("./sw.js").catch(() => {});
  sw.addEventListener("controllerchange", () => {
    if (!hadController) return;
    pending = true;
    reloadIfSafe();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    reloadIfSafe();
    sw.getRegistration().then(r => r && r.update()).catch(() => {});
  });
  setInterval(reloadIfSafe, 4000);   // シートを閉じたあとにも反映する
})();
