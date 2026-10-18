// backup-file.js — データの書き出し・復元のファイル受け渡し(トラッカーとジム共通)。
// iPhoneのホーム画面アプリでは <a download> がうまく動かず、DOMに置いていない
// <input type=file> は選んでも change が来ないことがある。
// 書き出しは共有シート(「"ファイル"に保存」等)を優先し、復元の選択欄は画面に置いて使う。
(function () {
  function save(name, text) {
    const blob = new Blob([text], { type: "application/json" });
    let file = null;
    try { file = new File([blob], name, { type: "application/json" }); } catch (e) { /* old browser */ }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file] }).catch(err => {
        if (err && err.name === "AbortError") return;   // 共有シートを閉じただけ
        download(blob, name);
      });
    }
    download(blob, name);
    return Promise.resolve();
  }
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    // すぐ捨てるとiPhoneではダウンロードが始まる前に消える
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  }
  // onText(text) を選んだファイルの中身で呼ぶ。読めなければ onError()
  function pick(onText, onError) {
    document.querySelectorAll("input[data-backup-pick]").forEach(x => x.remove());
    const inp = document.createElement("input");
    inp.type = "file";
    // 種類で絞るとiPhoneの「ファイル」で .json がグレーになって選べないことがある
    inp.setAttribute("data-backup-pick", "");
    inp.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(inp);
    let done = false;
    const handle = () => {
      if (done) return;
      const f = inp.files && inp.files[0];
      if (!f) return;
      done = true;
      const r = new FileReader();
      r.onload = () => { inp.remove(); onText(String(r.result || "")); };
      r.onerror = () => { inp.remove(); onError(); };
      r.readAsText(f);
    };
    inp.addEventListener("change", handle);
    inp.addEventListener("input", handle);
    inp.addEventListener("cancel", () => inp.remove());
    inp.click();
  }
  window.BackupFile = { save, pick };
})();
