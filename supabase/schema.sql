-- スポットクリエイト：Supabase の準備（SQL Editor に全部貼り付けて「Run」を押すだけ）
-- 何度実行しても大丈夫なように書いてあります。

-- ========== データを入れる表 ==========
-- col = 種類（works / episodes / pages / comments / members / views / reports / moderation / spotlight / banners / admins）
-- id  = その中での名前、data = 中身
create table if not exists public.docs (
  col        text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  owner      uuid                 default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
create index if not exists docs_work_idx on public.docs (col, (data->>'workId'));
alter table public.docs enable row level security;
alter table public.docs replica identity full;

-- ========== ルールで使う関数 ==========
-- 運営か（admins に自分のユーザーIDがあるか）
create or replace function public.sc_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from public.docs where col = 'admins' and id = auth.uid()::text);
$$;

-- ログインしていて、運営に利用を停止されていないか
create or replace function public.sc_active() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and not exists (select 1 from public.docs
                     where col = 'members' and id = auth.uid()::text and data->>'approved' = 'false');
$$;

-- 投稿できるか（プロフィール登録済み・停止されていない・18歳以上か保護者の同意あり）
create or replace function public.sc_can_post() returns boolean
language sql stable security definer set search_path = public as $$
  select public.sc_is_admin() or coalesce((
    select coalesce(data->>'approved', 'true') <> 'false'
       and (data->>'age' = 'adult' or data->>'guardian' = 'true')
      from public.docs where col = 'members' and id = auth.uid()::text), false);
$$;

-- 自分のものか（作品・話は authorId、画像・コメントは uid で判断）
create or replace function public.sc_mine(c text, d jsonb) returns boolean
language sql immutable as $$
  select case
    when c in ('works', 'episodes') then d->>'authorId' = auth.uid()::text
    when c in ('pages', 'comments') then d->>'uid' = auth.uid()::text
    else false end;
$$;

-- ========== 読む・書くのルール ==========
drop policy if exists docs_read   on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

-- 読む：だれでも（ログインなしでも）読める。運営の名簿と通報は、本人と運営だけ。
create policy docs_read on public.docs for select using (
  col not in ('admins', 'reports') or id = auth.uid()::text or public.sc_is_admin()
);

-- 新しく書く
create policy docs_insert on public.docs for insert with check (
  case
    when col = 'members' then id = auth.uid()::text and coalesce(data->>'approved', 'true') <> 'false'
    when col in ('works', 'episodes', 'pages', 'comments') then public.sc_can_post() and public.sc_mine(col, data)
    when col = 'views'   then id = auth.uid()::text and public.sc_active()
    when col = 'reports' then id = auth.uid()::text and public.sc_active()
    when col in ('moderation', 'spotlight', 'banners') then public.sc_is_admin()
    else false
  end
);

-- 書きかえる（作者本人か運営。作者を他人に変えることはできない）
create policy docs_update on public.docs for update using (
  public.sc_is_admin()
  or (col = 'members' and id = auth.uid()::text)
  or (col in ('views', 'reports') and id = auth.uid()::text and public.sc_active())
  or (col in ('works', 'episodes', 'pages', 'comments') and public.sc_mine(col, data) and public.sc_can_post())
) with check (
  public.sc_is_admin()
  or (col = 'members' and id = auth.uid()::text)
  or (col in ('views', 'reports') and id = auth.uid()::text)
  or (col in ('works', 'episodes', 'pages', 'comments') and public.sc_mine(col, data))
);

-- 消す（作者本人か運営）
create policy docs_delete on public.docs for delete using (
  public.sc_is_admin()
  or (col in ('works', 'episodes', 'pages', 'comments') and public.sc_mine(col, data))
);

-- 書きこむたびに：更新日時をつける／最初に書いた人を変えさせない／利用停止は運営だけが変えられる
create or replace function public.sc_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.owner := old.owner;
    if new.col = 'members' and not public.sc_is_admin()
       and (new.data->'approved') is distinct from (old.data->'approved') then
      raise exception 'approved can be changed by admins only' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs
  for each row execute function public.sc_guard();

-- ========== 画像の置き場所（Storage） ==========
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pages', 'pages', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "sc pages read"   on storage.objects;
drop policy if exists "sc pages insert" on storage.objects;
drop policy if exists "sc pages update" on storage.objects;
drop policy if exists "sc pages delete" on storage.objects;
create policy "sc pages read"   on storage.objects for select using (bucket_id = 'pages');
create policy "sc pages insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'pages' and public.sc_can_post());
create policy "sc pages update" on storage.objects for update to authenticated
  using (bucket_id = 'pages' and (owner = auth.uid() or public.sc_is_admin()));
create policy "sc pages delete" on storage.objects for delete to authenticated
  using (bucket_id = 'pages' and (owner = auth.uid() or public.sc_is_admin()));

-- ========== 変更をすぐ画面に届ける（Realtime） ==========
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; when undefined_object then null;
end $$;

-- ========== 運営の登録 ==========
-- サイトの「マイページ」に出る「あなたのユーザーID」を下の '...' に入れて、この1行だけ実行します。
-- insert into public.docs (col, id, data) values ('admins', 'ここにユーザーID', '{}'::jsonb) on conflict do nothing;
