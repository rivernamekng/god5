-- Supabase SQL Editor で実行してください。
-- 既存のgodfive_roomsテーブルがある場合でもそのまま実行できます
-- (create table / add column はすべて存在チェック付きです)。
create table if not exists public.godfive_rooms (
  code text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- revision: 楽観的排他制御(同時書き込みの衝突防止)に使用する版数。
-- 既存テーブルに対しても安全に追加できる(デフォルト0で埋まる)。
alter table public.godfive_rooms
  add column if not exists revision integer not null default 0;

alter table public.godfive_rooms enable row level security;

-- 友人同士の私的利用を想定した簡易ポリシーです。
-- 秘密情報は置かないでください。
drop policy if exists "rooms_select_anon" on public.godfive_rooms;
drop policy if exists "rooms_insert_anon" on public.godfive_rooms;
drop policy if exists "rooms_update_anon" on public.godfive_rooms;

create policy "rooms_select_anon"
on public.godfive_rooms for select
to anon
using (true);

create policy "rooms_insert_anon"
on public.godfive_rooms for insert
to anon
with check (true);

create policy "rooms_update_anon"
on public.godfive_rooms for update
to anon
using (true)
with check (true);

alter table public.godfive_rooms replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'godfive_rooms'
  ) then
    alter publication supabase_realtime add table public.godfive_rooms;
  end if;
end $$;
