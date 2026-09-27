# Monk companion actions

Gym Questの主人公に「構え→正拳突き→構え」と「構え→力こぶポーズ→構え」を追加。普段は既存の2コマidleを使う。

- 通常は18〜32秒ごとに、正拳突き（0.8秒）と力こぶ（1.76秒）を交互に再生。
- モンクをタップ／キーボード操作でも再生。動作中の連打や短時間の連続再生は抑制。
- 新たに3/4/5種目を達成すると力こぶで反応。画面外で達成した場合は5秒以内に戻ったときのみ再生し、後から古い演出を積み上げない。
- 画面外、別タブ、PWAのバックグラウンドではタイマーとidleを停止。復帰時は待機から再開。
- 入力欄／モーダル操作中は新しいアクションを抑制。
- `prefers-reduced-motion` では静止表示。アクション素材が読めない場合は既存idleを維持。
- Lv1/10/20/30/40に対応。idleが下位レベルへフォールバックした場合はアクションもその衣装に合わせる。
- 記録・XP・localStorage・プラン生成の計算は変更なし。アクションは保存データを書き換えない。
- SW v47に表示モジュールと5つのWebPを追加し、オフラインでも利用可能。

## Files

`js/monk-companion.mjs` は表示とライフサイクルのみを担当。Gymの再描画時にはdetachして古いタイマーとIntersectionObserverを破棄する。

[素材と生成プロンプト](monk-action-prompts.md)。画像生成ツールでポーズを作成後、既存idleと足元・身長を揃えて組み込み。元のidle PNGは変更していない。

## Validation

```sh
node --test tests/*.test.mjs
BROWSER_PATH=<chromium> node tests/gym-ui.cjs
BROWSER_PATH=<chromium> node tests/monk-actions-ui.cjs
```

PlaywrightとChromiumは確認環境のみ。125件のロジックテストと既存Gym回帰、アクション遷移／連打／省アニメーション／背景復帰／画面外／タブ切替／達成時／全レベル／ストレージ不変／素材取得失敗／オフラインを確認。320/375/390/430/1024pxで表示確認。
実機iPhone・Safariは未確認。

プレビューは実画面キャプチャ。見比べるため通常の待機時間を短縮している（テスト用データ）。

![正拳突きと力こぶ](screenshots/monk-actions.gif)
