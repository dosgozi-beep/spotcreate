# スポットクリエイト

小説と漫画を投稿できる、クローズドコミュニティ向けの物語プラットフォーム。

- 見る人はログイン不要。投稿・コメントするときにペンネームと年齢を登録します（18歳未満は保護者の同意が必要）。
- ページは GitHub Pages、データと画像は Supabase に保存します。

## 構成

| ファイル | 内容 |
|---|---|
| `index.html` | サイト本体 |
| `js/backend.js` | Supabase との接続 |
| `js/supabase-config.js` | Supabase の Project URL と公開用キー |
| `supabase/schema.sql` | データベースの表・ルール・画像置き場の作成（SQL Editor で実行） |
| `assets/` | ロゴなど |

## 運営の登録

サイトの「マイページ」→「あなたのユーザーID」を開いてコピーし、Supabase の SQL Editor で次を実行します。

```sql
insert into public.docs (col, id, data) values ('admins', 'ここにユーザーID', '{}'::jsonb) on conflict do nothing;
```
