-- =========================================================
-- RateMyProf - Supabase schema
-- File: ratemyprof/frontend/supabase_ratings_schema.sql
--
-- Purpose:
-- 1) Store professor ratings with one-row-per-user-per-professor upsert key
-- 2) Enforce authenticated ownership policies for insert/update (upsert-safe)
-- 3) Add moderation lifecycle fields and moderator controls
-- =========================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- 1) Helper functions
-- ---------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.compute_overall_rating()
returns trigger
language plpgsql
as $$
declare
  v_avg numeric(3,2);
begin
  v_avg := round((
    coalesce(new.teaching_quality, 0)
    + coalesce(new.understandability, 0)
    + coalesce(new.behavior, 0)
    + coalesce(new.english_level, 0)
    + coalesce(new.availability, 0)
  )::numeric / 5, 2);

  -- Keep server-side truth of overall rating.
  new.overall_rating = greatest(1, least(5, v_avg));
  return new;
end;
$$;

create or replace function public.is_moderator()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator', false);
$$;

create or replace function public.prevent_non_moderation_edits()
returns trigger
language plpgsql
as $$
begin
  -- Moderators can edit moderation fields.
  if public.is_moderator() then
    return new;
  end if;

  -- Non-moderators cannot change moderation columns.
  if new.moderation_status is distinct from old.moderation_status
     or new.moderation_reason is distinct from old.moderation_reason
     or new.moderated_by is distinct from old.moderated_by
     or new.moderated_at is distinct from old.moderated_at
     or new.is_hidden is distinct from old.is_hidden
     or new.report_count is distinct from old.report_count then
    raise exception 'Only moderators can edit moderation fields.';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------
-- 2) Main table
-- ---------------------------------------------------------

create table if not exists public.professor_ratings (
  id uuid primary key default gen_random_uuid(),

  -- Ownership / upsert identity
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_url text not null,

  -- Denormalized reference fields
  professor_name text,
  department text,
  reviewer_university text,
  reviewer_course text,

  -- Ratings (1..5)
  teaching_quality smallint not null check (teaching_quality between 1 and 5),
  understandability smallint not null check (understandability between 1 and 5),
  behavior smallint not null check (behavior between 1 and 5),
  english_level smallint not null check (english_level between 1 and 5),
  availability smallint not null check (availability between 1 and 5),

  -- Stored and server-recomputed in trigger
  overall_rating numeric(3,2) not null check (overall_rating >= 1 and overall_rating <= 5),
  review_text text,

  -- Moderation fields
  moderation_status text not null default 'pending'
    check (moderation_status in ('pending', 'approved', 'rejected', 'flagged')),
  moderation_reason text,
  moderated_by uuid references auth.users(id) on delete set null,
  moderated_at timestamptz,
  is_hidden boolean not null default false,
  report_count integer not null default 0 check (report_count >= 0),

  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Authenticated upsert key (used by frontend upsert on user_id, profile_url)
  constraint professor_ratings_user_profile_unique unique (user_id, profile_url)
);

-- ---------------------------------------------------------
-- 3) Indexes
-- ---------------------------------------------------------

create index if not exists idx_professor_ratings_profile_url
  on public.professor_ratings (profile_url);

create index if not exists idx_professor_ratings_department
  on public.professor_ratings (department);

create index if not exists idx_professor_ratings_created_at
  on public.professor_ratings (created_at desc);

create index if not exists idx_professor_ratings_status_hidden
  on public.professor_ratings (moderation_status, is_hidden);

create index if not exists idx_professor_ratings_professor_name_tsv
  on public.professor_ratings
  using gin (to_tsvector('simple', coalesce(professor_name, '')));

-- ---------------------------------------------------------
-- 4) Triggers
-- ---------------------------------------------------------

drop trigger if exists trg_professor_ratings_set_updated_at on public.professor_ratings;
create trigger trg_professor_ratings_set_updated_at
before update on public.professor_ratings
for each row
execute function public.set_updated_at();

drop trigger if exists trg_professor_ratings_compute_overall on public.professor_ratings;
create trigger trg_professor_ratings_compute_overall
before insert or update on public.professor_ratings
for each row
execute function public.compute_overall_rating();

drop trigger if exists trg_professor_ratings_protect_moderation on public.professor_ratings;
create trigger trg_professor_ratings_protect_moderation
before update on public.professor_ratings
for each row
execute function public.prevent_non_moderation_edits();

-- ---------------------------------------------------------
-- 5) Summary view (public-facing aggregate)
-- ---------------------------------------------------------

create or replace view public.professor_rating_summary as
select
  profile_url,
  max(professor_name) as professor_name,
  max(department) as department,
  count(*)::int as reviews_count,
  round(avg(teaching_quality)::numeric, 2) as avg_teaching_quality,
  round(avg(understandability)::numeric, 2) as avg_understandability,
  round(avg(behavior)::numeric, 2) as avg_behavior,
  round(avg(english_level)::numeric, 2) as avg_english_level,
  round(avg(availability)::numeric, 2) as avg_availability,
  round(avg(overall_rating)::numeric, 2) as avg_overall_rating,
  max(created_at) as last_review_at
from public.professor_ratings
where moderation_status = 'approved'
  and is_hidden = false
group by profile_url;

-- ---------------------------------------------------------
-- 6) RLS
-- ---------------------------------------------------------

alter table public.professor_ratings enable row level security;

drop policy if exists "Public can read approved visible ratings" on public.professor_ratings;
drop policy if exists "Users can read own ratings" on public.professor_ratings;
drop policy if exists "Authenticated users can insert own ratings" on public.professor_ratings;
drop policy if exists "Authenticated users can update own ratings" on public.professor_ratings;
drop policy if exists "Moderators can read all ratings" on public.professor_ratings;
drop policy if exists "Moderators can update all ratings" on public.professor_ratings;
drop policy if exists "Moderators can delete ratings" on public.professor_ratings;

-- Public read: only approved + visible
create policy "Public can read approved visible ratings"
on public.professor_ratings
for select
to anon, authenticated
using (
  moderation_status = 'approved'
  and is_hidden = false
);

-- Owners read their own rows (including pending/rejected)
create policy "Users can read own ratings"
on public.professor_ratings
for select
to authenticated
using (auth.uid() = user_id);

-- Upsert insert leg
create policy "Authenticated users can insert own ratings"
on public.professor_ratings
for insert
to authenticated
with check (
  auth.uid() = user_id
);

-- Upsert update leg
create policy "Authenticated users can update own ratings"
on public.professor_ratings
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Moderator policies
create policy "Moderators can read all ratings"
on public.professor_ratings
for select
to authenticated
using (public.is_moderator());

create policy "Moderators can update all ratings"
on public.professor_ratings
for update
to authenticated
using (public.is_moderator())
with check (public.is_moderator());

create policy "Moderators can delete ratings"
on public.professor_ratings
for delete
to authenticated
using (public.is_moderator());

-- ---------------------------------------------------------
-- 7) Grants
-- ---------------------------------------------------------

grant usage on schema public to anon, authenticated;

grant select
on public.professor_ratings
to anon, authenticated;

grant insert, update
on public.professor_ratings
to authenticated;

grant select
on public.professor_rating_summary
to anon, authenticated;
