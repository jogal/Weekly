# 習慣トラッカー（今日タブ・ゴールド・ショップ）

Grit 風の「今日」画面を週クエの主画面にし、習慣ごとの目標と、連続達成で貯まるゴールド・アイテムを追加した。

## 構成

- `js/habit-core.mjs`: 純粋ロジック。目標・頻度・進捗・連続記録・ゴールド精算・護符・ショップ・達成率。DOMとlocalStorageに触らない
- `tracker.html` の `<script type="module">`: 今日タブ、詳細・編集シート、育成タブのゴールドとショップ、統計タブの達成度
- 既存の classic script は `window.HabitUI` を呼ぶだけ。週間カレンダーは予定タブのボタンから開く

## データ

| キー | 中身 |
| --- | --- |
| `wt_habits_v1` | 習慣の定義（名前・アイコン・色・目標・頻度・連動先・アーカイブ） |
| `wt_habit_log_v1` | 独自習慣の回数／分数と、休息日フラグ（連動習慣の休息もここ） |
| `wt_reward_v1` | 確定済みゴールド、未確定7日分の内訳、購入・装備・護符の使用日 |

- 連動習慣の正本は `wt_records`。今日タブから記録すると `wt_records` に書くので、記録タブ・XP・統計にそのまま出る
- ゴールドは読み込みのたびに「未確定の日〜今日」を記録から計算し直す。7日より前は合計に畳み込んで確定する
- 既存キーのスキーマは変更しない。バックアップ（書き出し／復元）に3キーを追加

## クエスト掲示板

- `js/quest-core.mjs`: クエストの定義（`QUEST_LINES`、独自習慣ごとの専用ライン）、記録からの進捗集計、掲示板の状態、受け取り
- 進捗は `wt_records`・`wt_habit_log_v1`・メダルから毎回数える。保存するのは `wt_reward_v1.quests.claimed`（クエストIDと受け取り日）だけ
- 受け取りでゴールドを `grants` に足し、限定アイテム（称号・背景）を `owned` に入れる。限定アイテムはショップでは買えない（`purchase` が `quest` で拒否）
- おともは休止中。`RETIRED_ITEMS` に入れたアイテムは読み込み時に購入・所持・装備から取り除き、払ったゴールドは戻る
- 指標: 記録の完了日数（筋トレは部位をまとめて1日）、部位ごとの日数、累計分、何か達成した日数、習慣の達成回数、パーフェクトデイ、メダル数

## ごほうびチケット

- `wt_reward_v1.wishes`: ごほうびリスト（id・名前・アイコン・値段）。未設定の古い保存データには初期の3つを入れる。全部消した `[]` はそのまま
- `wt_reward_v1.tickets`: 買ったチケット。購入時の名前・アイコン・値段を写して持つので、リストを編集・削除しても変わらない。`usedOn` が入ったら使用済みで、2回目は `useTicket` が `used` で拒否
- 購入は `purchases` に `ticket:<wishId>` として入り、既存の残高計算にそのまま反映される
- 値段の目安は直近7日（今日を除く）の1日あたりの稼ぎから計算する

## 統計の数え方の修正

統計タブの「達成回数」とカテゴリ別の回数は、予定に入っていた記録しか数えていなかった。今日タブ・ジム・Neuro Learn からの予定外の記録も数えるよう、完了記録ベースに変更した。

## Validation

```sh
node --test tests/*.test.mjs
BROWSER_PATH=<chromium> node tests/habit-ui.cjs
BROWSER_PATH=<chromium> node tests/quest-ui.cjs
BROWSER_PATH=<chromium> node tests/ticket-ui.cjs
BROWSER_PATH=<chromium> node tests/app-ui.cjs
```

実機 iPhone / Safari での長押し操作は未確認。
