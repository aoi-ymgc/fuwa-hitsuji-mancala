# 描き下ろしイラスト制作記録

## 実装済みアセット

| ファイル | 用途 | 状態 |
| --- | --- | --- |
| `apps/web/public/assets/hero-mancala-v2.webp` | トップ画面のキービジュアル | 実装済み |
| `apps/web/public/assets/waiting-room.webp` | マッチング待機画面 | 実装済み |
| `apps/web/public/assets/result-moods.webp` | 勝利・敗北・引き分けの3分割結果イラスト | 実装済み |
| `apps/web/public/assets/cutin-extra-turn.webp` | 追加ターン用カットイン | 実装済み |
| `apps/web/public/assets/cutin-capture.webp` | 石獲得用カットイン | 実装済み |
| `apps/web/public/assets/ohajiki-sprites.webp` | 盤面と移動演出のおはじき4色 | 実装済み |
| `apps/web/public/assets/rules-board.webp` | 遊び方カード用の実盤面プレビュー | 実装済み |

いずれも組み込みの Image Generation を使用し、既存の「ふわっとひつじ」画像はキャラクター同一性の参照だけに利用した新規制作です。共通基準は、白いもこもこ頭と体、丸いベージュの顔、小さな黒い目、薄いピンクの頬、濃色のひづめ、ミントのスカーフ、くっきりした手描き線、クリーム・ミント・蜂蜜色の配色です。

## 生成に使用したプロンプト

### トップ画面

> ふわっとひつじが木製のカラハ盤の横に座り、ミント・クリーム・コーラル・金色の毛糸玉を反時計回りに配る、新規の絵本風キービジュアル。盤は小穴6個×2列と大きなストア2個が明瞭。左上にHTMLタイトル用の余白を確保。クリーム色の草原、クローバーと小さな星。日本の商用絵本のような、くっきりした手描き線と不透明なフラットカラー、軽い紙の質感。文字、ロゴ、透かし、3D、写真、ぼやけた水彩、過度なグラデーションは禁止。

### 結果画面

> 同じふわっとひつじを横3等分のビネットで描く。左は毛糸玉を投げて喜ぶ勝利、中央は毛糸玉を抱えて少し残念そうだが温かい敗北、右は同じ毛糸玉を2個抱えて穏やかな引き分け。各区画に羊1体、同一スケール、安全な余白、文字なし。クリーム紙、ミント、蜂蜜色、控えめなコーラルと水色。商用絵本品質の明瞭な線とフラットカラー。

### 待機画面

> ふわっとひつじがクリーム色の敷物に座り、片手に無地の招待カード、もう片手にミント色の毛糸玉を持って友だちを待つ。空の座布団2枚と小さな木製カラハ盤を置く。アイボリーの紙背景、少量のクローバー、点線の道、蜂蜜色の星。羊は1体、全身、中央配置、160px表示でも読める明瞭さ。文字、ロゴ、透かし、複雑な背景は禁止。

### おはじきスプライト

Built-in Image Generation で生成し、単色背景をローカル除去して4色の透過WebPへ整形しました。

> Use case: stylized-concept
> Asset type: 2D browser game token spritesheet for tiny mancala stones
> Primary request: Create four separate, perfectly round Japanese ohajiki-style glass game pieces, viewed directly from above: mint green, warm coral, honey amber, and pale cream. Each piece should feel tactile and clearly readable at 12–20 px, with a thick colored glass rim, brighter translucent center, a crisp white highlight, and a very subtle inner swirl. Keep all four tokens the same size and visual weight.
> Input images: the Fuwatto Mancala hero is a palette and gentle picture-book world reference only; do not include sheep, board, flowers, or scenery.
> Scene/backdrop: perfectly flat solid #ff00ff chroma-key background for background removal, uniform edge-to-edge with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
> Style/medium: polished hand-painted 2D game UI asset with clean edges, not photorealistic, not 3D rendered.
> Composition/framing: four tokens in a single horizontal row, centered, wide generous separation and padding, no overlap; each token isolated cleanly.
> Color palette: mint, coral, honey amber, warm cream; no magenta anywhere in the tokens.
> Constraints: no text, no numbers, no logo, no watermark, no cast shadow, no contact shadow, no background objects, no extra tokens, no malformed circles, keep subjects fully separated from background with crisp edges.

`rules-board.webp` は実装後の盤面を同一表示サイズで撮影・確認した画像から、盤面全体が入るように切り出したものです。

## 今後差し替え可能な追加素材

- チュートリアル用3コマ: 「穴を選ぶ」「1個ずつ配る」「最後の石を強調」。盤面の向きと穴数を実UIに合わせる。
- 追加ターン表情: ひつじが毛糸玉をもう1個掲げる。文字はHTMLで重ねるため画像内には入れない。
- 獲得表情: ひつじが向かい側の毛糸玉を自分のかごへ集める。捕獲ではなく「集める」温かな表現にする。
- 再接続待機: スカーフを握り、遠くの点線を見ながら落ち着いて待つ。通信エラーを怖く見せない。

追加素材も `public/assets` に意味のある英字名で配置し、画像内テキストは避けて文言をHTML側に残します。
