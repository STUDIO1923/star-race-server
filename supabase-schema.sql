create table if not exists public.player_saves (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Player',
  total_stars integer not null default 0 check (total_stars >= 0),
  level integer not null default 1 check (level >= 1),
  character_id text not null default 'hero_blue',
  updated_at timestamptz not null default now()
);

alter table public.player_saves enable row level security;

create policy "Players can read their own save"
on public.player_saves for select
to authenticated
using ((select auth.uid()) = user_id);

-- Writes go through the trusted Render server using its service-role key.
