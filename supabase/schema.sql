-- Kaiser Stats — Supabase schema
--
-- Stores the *inputs* to the existing TypeScript stats engine
-- (src/lib/stats-engine/), not a re-implementation of it. Tables mirror
-- SeasonStandingRow / GameRecord / PlayerIdentity from types.ts closely on
-- purpose, so a query layer can fetch rows and feed them straight through
-- aggregateStandings() / rollupGameRecords() — the aggregation logic itself
-- has exactly one implementation, in TypeScript, already tested. See
-- docs/data-contract.md.
--
-- PRIVACY: every table here can hold real player names/emails and real
-- attendance/stats data. Row Level Security is enabled on all of them with
-- NO public policies — nothing is readable via the anon/public API. Only the
-- service_role key (server-side only, e.g. the backfill script; never
-- NEXT_PUBLIC_-prefixed, never sent to a browser) can read or write. Adding
-- any public SELECT policy here is a decision to make deliberately later,
-- not a default.

create table if not exists players (
  canonical_id text primary key,
  display_name text not null,
  aliases text[] not null default '{}',
  known_emails text[] not null default '{}',
  leagues text[] not null default '{}',
  -- 'provisional' included alongside the identity-resolution statuses (see
  -- createProvisionalIdentity()/createProvisionalIdentityFromEmail() in
  -- src/lib/stats-engine/identity.ts) — both the name-ingestion path and the
  -- login path auto-provision under this status rather than blocking.
  status text not null check (status in ('regular', 'guest', 'deferred', 'example', 'provisional')),
  -- Links this player to their Supabase Auth identity, set on first login
  -- (see src/app/auth/callback/route.ts). Most rows (backfilled from
  -- spreadsheets) will never log in and stay null.
  auth_user_id uuid unique references auth.users (id),
  -- Deliberately a single flag, not the fuller Player/Captain/Admin role
  -- model from kaiser_step1_concept.md — that's still deferred.
  is_admin boolean not null default false
);

alter table players enable row level security;

-- One row per (player, source-sheet) — the normalized output of
-- parseSeasonStandingsSheet(), before name resolution. Mirrors
-- SeasonStandingRow exactly.
create table if not exists season_standing_rows (
  id bigint generated always as identity primary key,
  source text not null,
  league text not null check (league in ('saturday', 'sunday', 'unknown')),
  player_name_raw text not null,
  -- Set once resolvePlayerName() finds an exact match; left null for a
  -- flagged/unresolved name rather than guessed — see unresolved_names_log.
  player_canonical_id text references players (canonical_id),
  games integer not null,
  wins integer not null,
  losses integer not null,
  ties integer not null,
  goals integer,
  plus_minus integer,
  percent numeric,
  points numeric
);

alter table season_standing_rows enable row level security;
create index if not exists season_standing_rows_player_idx on season_standing_rows (player_canonical_id);

-- Mirrors GameRecord. Populated by the future LLM report-parser; the
-- backfill script only ever writes season_standing_rows (spreadsheets never
-- had per-game granularity — see docs/data-contract.md), so this stays empty
-- until report parsing exists.
create table if not exists game_records (
  game_id text primary key,
  date date not null,
  league text not null check (league in ('saturday', 'sunday', 'unknown')),
  -- Null means a "no report" game: a real team-split roster is known (real
  -- roster_spots rows exist) but no score was ever emailed and never will
  -- be recoverable. Always both-null-or-both-set together. See GameRecord.
  home_score integer,
  away_score integer,
  mvp_canonical_id text references players (canonical_id),
  -- Admin-pasted free-text summary of the game (originally lifted from the
  -- league organizer's report message). No admin-editing UI exists yet.
  description text,
  source text not null
);

alter table game_records enable row level security;

create table if not exists roster_spots (
  id bigint generated always as identity primary key,
  game_id text not null references game_records (game_id) on delete cascade,
  canonical_id text not null references players (canonical_id),
  side text not null check (side in ('home', 'away')),
  pick_number integer not null
);

alter table roster_spots enable row level security;
create index if not exists roster_spots_game_idx on roster_spots (game_id);
create index if not exists roster_spots_player_idx on roster_spots (canonical_id);

create table if not exists goal_events (
  id bigint generated always as identity primary key,
  game_id text not null references game_records (game_id) on delete cascade,
  scorer_canonical_id text not null references players (canonical_id),
  assist_canonical_id text references players (canonical_id),
  team text not null check (team in ('home', 'away'))
);

alter table goal_events enable row level security;
create index if not exists goal_events_game_idx on goal_events (game_id);

create table if not exists notable_mentions (
  id bigint generated always as identity primary key,
  game_id text not null references game_records (game_id) on delete cascade,
  canonical_id text not null references players (canonical_id),
  quote text not null
);

alter table notable_mentions enable row level security;
create index if not exists notable_mentions_game_idx on notable_mentions (game_id);

-- Every name resolvePlayerName() couldn't exactly-match during a backfill
-- run — flagged or fully unresolved, mirrors NameResolution. Never
-- auto-merged; this is the durable "needs a human" queue (see
-- kaiser_BUILD_SPEC.md's identity-resolution rules and
-- kaiser_owner_ask_list.md's identity-confirmation batch).
create table if not exists unresolved_names_log (
  id bigint generated always as identity primary key,
  raw_name text not null,
  status text not null check (status in ('flagged', 'unresolved')),
  candidate_canonical_id text references players (canonical_id),
  candidate_distance integer,
  source text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_canonical_id text references players (canonical_id)
);

alter table unresolved_names_log enable row level security;

-- Migration (2026-07-14): auth support for email/magic-link login.
-- Run this once in the Supabase SQL Editor against the existing project —
-- the players table already exists there, so the CREATE TABLE above won't
-- apply these changes retroactively. No new RLS policy is added anywhere:
-- the login flow only ever touches Supabase's own auth.users table from the
-- browser (via the anon key) and only ever touches players server-side via
-- the service_role key (src/lib/supabase/client.ts) — the "RLS enabled, zero
-- public policies" invariant on every table here stays exactly as-is.

-- 1. Fix a latent bug: PlayerIdentity.status (src/lib/stats-engine/types.ts)
--    has included "provisional" since the identity-resolution work, but this
--    CHECK constraint never did. Auto-provisioned login identities need to
--    insert with status='provisional', which would violate this constraint
--    as written today.
--    Verify the actual constraint name first — it should be the
--    Postgres-default "players_status_check" for a table created via the
--    unnamed inline CHECK in this file, but confirm before dropping:
--      select conname from pg_constraint
--      where conrelid = 'players'::regclass and contype = 'c';
alter table players drop constraint players_status_check;
alter table players add constraint players_status_check
  check (status in ('regular', 'guest', 'deferred', 'example', 'provisional'));

-- 2. Link a players row to its Supabase Auth identity. Nullable + unique:
--    most existing rows (backfilled from spreadsheets) will never log in and
--    have no auth account; at most one player row per auth user.
alter table players add column if not exists auth_user_id uuid unique references auth.users (id);

-- 3. Simplest possible admin flag. Deliberately not the fuller
--    Player/Captain/Admin role model from kaiser_step1_concept.md — that's
--    explicitly deferred until/unless a live draft feature is built.
alter table players add column if not exists is_admin boolean not null default false;

-- Migration (2026-07-14): real Matchday scheduling + check-ins.
-- Replaces data/sample/scheduled-games.json as Matchday's source of truth
-- (see src/lib/matchday/data.ts). Scoped to Matchday only — Table/Past
-- Matches/Player Detail stay on data/sample/ for now. No public RLS policies
-- added: every read/write of these two tables goes through
-- createServiceRoleClient(), same invariant as every other table here.

create table if not exists scheduled_games (
  game_id text primary key,
  date date not null,
  league text not null check (league in ('saturday', 'sunday'))
);

alter table scheduled_games enable row level security;

-- One row per check-in *event* (soft-deleted via removed_at/removed_by,
-- never hard-deleted) rather than a mutable array — gets an audit trail
-- (who added/removed whom, and when) almost for free, matching
-- kaiser_step1_concept.md's "admin action log" idea. Only admins
-- insert/update this table today (checked_in_by/removed_by are always an
-- admin's canonical_id) — a future public self-check-in slice would need
-- its own path, not assumed here.
create table if not exists game_checkins (
  id bigint generated always as identity primary key,
  game_id text not null references scheduled_games (game_id) on delete cascade,
  canonical_id text not null references players (canonical_id),
  checked_in_at timestamptz not null default now(),
  checked_in_by text not null references players (canonical_id),
  removed_at timestamptz,
  removed_by text references players (canonical_id)
);

alter table game_checkins enable row level security;
create index if not exists game_checkins_game_idx on game_checkins (game_id);
create index if not exists game_checkins_player_idx on game_checkins (canonical_id);

-- At most one *active* check-in per (game, player) at a time. Re-adding
-- after a removal inserts a new row (the old one keeps its removed_at
-- stamp) rather than erroring.
create unique index if not exists game_checkins_active_unique
  on game_checkins (game_id, canonical_id) where removed_at is null;

-- Seed the 5 games already described in data/sample/scheduled-games.json.
-- No check-ins are seeded — that file's demo-cXXX ids are anonymized/fake
-- and don't exist in the real players table.
insert into scheduled_games (game_id, date, league) values
  ('matchday-2026-07-18', '2026-07-18', 'saturday'),
  ('matchday-2026-07-19', '2026-07-19', 'sunday'),
  ('matchday-2026-07-25', '2026-07-25', 'saturday'),
  ('matchday-2026-07-26', '2026-07-26', 'sunday'),
  ('matchday-2026-08-01', '2026-08-01', 'saturday')
on conflict (game_id) do nothing;

-- Migration (2026-07-14): registration open-time, cron-generated recurring
-- games, admin cancellation, and one-off (non-recurring) games. No new RLS
-- policy — scheduled_games access still goes exclusively through
-- createServiceRoleClient(), same invariant as every table above.

-- Null kickoff_label/venue mean "fall back to KICKOFF_LABEL_BY_LEAGUE /
-- VENUE_BY_LEAGUE for this game's league" (see src/lib/matchday/data.ts) —
-- only a one-off holiday game sets these explicitly.
alter table scheduled_games add column if not exists kickoff_label text;
alter table scheduled_games add column if not exists venue text;

-- True for the weekly cron-generated games (src/app/api/matchday/generate-week),
-- false for an admin-created one-off game (src/lib/matchday/actions.ts's
-- createOneOffGame). Documentation today more than an enforced constraint —
-- the cron only ever inserts, never updates, so it can't collide with a
-- one-off row regardless.
alter table scheduled_games add column if not exists is_recurring boolean not null default true;

-- Cancellation is a one-way soft-delete (no un-cancel path in this slice),
-- same audit-trail style as game_checkins's removed_at/removed_by.
alter table scheduled_games add column if not exists cancelled_at timestamptz;
alter table scheduled_games add column if not exists cancelled_by text references players (canonical_id);

-- Set for an admin-created one-off game; null for cron-generated rows.
alter table scheduled_games add column if not exists created_by text references players (canonical_id);

-- Migration (2026-07-15): make roster_spots.pick_number nullable — report-parsed
-- games legitimately have no known draft order (see RosterSpot.pickNumber's doc
-- comment in src/lib/stats-engine/types.ts); the original NOT NULL constraint
-- predates any real write path and was never exercised until now.
alter table roster_spots alter column pick_number drop not null;

-- Migration (2026-07-16): "home"/"away" team display labels. Not null — the
-- app always resolves a value before writing (the report's own stated team
-- names when given, else a plain "Orange"/"Blue" default — see GameRecord's
-- homeTeamLabel/awayTeamLabel doc comment in src/lib/stats-engine/types.ts).
alter table game_records add column if not exists home_team_label text not null default 'Orange';
alter table game_records add column if not exists away_team_label text not null default 'Blue';

-- Migration (2026-07-16): game_records.description existed in this file's base
-- "create table if not exists" since before the live table was first created,
-- but that clause is a no-op against an already-existing table — the column
-- was never actually added to the real database (confirmed by a real
-- PGRST204 "Could not find the 'description' column" error on the first
-- attempt to save a real report). Needed for the report-import write path
-- (src/lib/report-parser/save.ts) to store the raw report text.
alter table game_records add column if not exists description text;

-- Migration (2026-07-16): per-year stats cutoff. season_standing_rows is a
-- cumulative spreadsheet snapshot as of some date; a report-imported
-- game_records row only adds to the Table's totals (see
-- src/lib/stats-engine/game-records.ts's mergePlayerSeasonStats and
-- selectStatsEligibleGames, wired in from src/app/page.tsx) when its date is
-- strictly after that year's cutoff_date here -- otherwise it's presumed
-- already counted in the spreadsheet. A year with no row here is a fully
-- closed season (spreadsheet already covers the whole year), so nothing
-- ever auto-counts for it. Only the current in-progress season needs a row;
-- update cutoff_date each time a newer spreadsheet gets backfilled
-- (see docs/data-contract.md).
create table if not exists season_stats_cutoff (
  year integer primary key,
  cutoff_date date not null
);

alter table season_stats_cutoff enable row level security;

-- Migration (2026-07-16): club chat. Same RLS-with-no-public-policies
-- posture as every other table in this app -- reads and writes both go
-- through the service-role client (src/lib/chat/data.ts, src/lib/chat/actions.ts),
-- gated by requiring a logged-in session server-side, never a public policy.
-- No Realtime wiring (that would need a public/authenticated SELECT policy for
-- the browser client to receive postgres_changes events) -- the chat page
-- polls (client-side refresh interval) instead, matching this app's existing
-- "no public policies, ever" rule rather than carving out an exception.
create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  sender_canonical_id text not null references players (canonical_id),
  content text not null,
  created_at timestamptz not null default now()
);

alter table chat_messages enable row level security;
create index if not exists chat_messages_created_at_idx on chat_messages (created_at);

-- Migration (2026-07-17): registration reminder emails. DRY RUN ONLY right
-- now (see src/lib/matchday/reminders.ts's SENDING_ENABLED constant) --
-- explicit project decision not to email real people yet (still in the demo
-- phase). This table's unique(game_id, email_type) is what makes the
-- send-reminders cron idempotent: once a row exists for a game+type, it's
-- never sent (or dry-run-logged) again, no matter how many times the cron
-- re-checks that same still-open window.
create table if not exists reminder_email_log (
  id bigint generated always as identity primary key,
  game_id text not null references scheduled_games (game_id),
  email_type text not null check (email_type in ('registration_open', 'closing_soon')),
  recipient_count integer not null,
  dry_run boolean not null default true,
  sent_at timestamptz not null default now(),
  unique (game_id, email_type)
);

alter table reminder_email_log enable row level security;

-- Migration (2026-07-17): live snake draft sessions. Multiple draft_sessions rows can
-- exist per game_id (a "redo" when the roster changes after an earlier draft) — the app
-- always reads/writes against the most recent one by created_at, no explicit
-- supersede/cancel flag needed. No new RLS policy — same service-role-only access as
-- every other table here.
create table if not exists draft_sessions (
  id bigint generated always as identity primary key,
  game_id text not null references scheduled_games (game_id),
  league text not null,
  status text not null default 'setup', -- 'setup' | 'in_progress' | 'completed'
  home_captain_canonical_id text references players (canonical_id),
  away_captain_canonical_id text references players (canonical_id),
  first_pick_side text, -- 'home' | 'away', set once the coin flip is recorded
  pool_canonical_ids text[] not null default '{}', -- draftable pool, captains excluded
  turn_sizes int[], -- admin-overridable pick-sequence; null until confirmed at start
  -- Players assigned to a side BEFORE the snake draft begins, to balance a
  -- lopsided pool (e.g. one very strong and one very weak player, handed one
  -- to each captain) — real roster members, but never part of the live pick
  -- sequence and never counted toward avgDraftPosition, same treatment as a
  -- captain. Capped at 2 per side in setPreDraftBalance(); empty is the
  -- normal case. See draft-actions.ts.
  home_balance_canonical_ids text[] not null default '{}',
  away_balance_canonical_ids text[] not null default '{}',
  created_by text not null references players (canonical_id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists draft_sessions_game_idx on draft_sessions (game_id);

create table if not exists draft_picks (
  id bigint generated always as identity primary key,
  draft_session_id bigint not null references draft_sessions (id) on delete cascade,
  pick_number int not null,
  side text not null, -- 'home' | 'away'
  canonical_id text not null references players (canonical_id),
  picked_at timestamptz not null default now(),
  unique (draft_session_id, pick_number)
);

alter table draft_sessions enable row level security;
alter table draft_picks enable row level security;

-- Migration (2026-07-19): roster-name onboarding. `roster_name` is the player's real
-- name as used in game reports (how a live-draft captain would recognize them) —
-- distinct from `display_name`, which is a personal app-UI preference a user can keep
-- editing in Settings. `roster_name` is only ever settable once by the user themselves
-- (at first-login onboarding, see completeOnboarding() in src/lib/auth/actions.ts);
-- afterward only an admin can correct it, via the Settings > Identities page.
-- `onboarding_completed_at` null means the onboarding gate applies; the backfill below
-- grandfathers in everyone who has already logged in before this migration, since
-- onboarding is a first-login gate going forward, not retroactive for existing members.
alter table players add column if not exists roster_name text;
alter table players add column if not exists onboarding_completed_at timestamptz;

update players set onboarding_completed_at = now()
  where auth_user_id is not null and onboarding_completed_at is null;

-- Migration (2026-07-19): per-game registration-cutoff override. Registration
-- close time is normally computed purely from fixed per-league constants (see
-- REGISTRATION_CUTOFF_BY_LEAGUE in src/lib/matchday/constants.ts) — this column
-- lets an admin override that computed default for one specific game (e.g. a
-- one-off game on an irregular day, or a schedule change), via the Edit Game
-- page. Null (the default) means "use the computed league default," exactly
-- today's existing behavior — see resolveRegistrationCutoffUtc() in
-- src/lib/matchday/registration-window.ts.
alter table scheduled_games add column if not exists registration_cutoff_override timestamptz;

-- Migration (2026-07-19): playable positions. Free-text array of the 9 basic
-- codes in src/lib/stats-engine/positions.ts (GK/LB/CB/RB/CM/CAM/LW/RW/ST) — not a
-- SQL check constraint, since it's validated in TypeScript (isPosition()) the same
-- way every other array column here (aliases, known_emails, leagues) is. Settable by
-- the member themselves at onboarding, or by an admin on their behalf via
-- Settings > Members (setMemberPositions() in src/lib/auth/actions.ts) — unlike
-- roster_name, a member can keep changing their own positions later too, via
-- Settings' plain SettingsForm, since this is a preference rather than an
-- identity-integrity concern. Empty array (the default) means "unknown/not set" —
-- the live draft's positional-need logic (position-need.ts) never penalizes that,
-- it only deprioritizes a player once every position they've actually listed is
-- already filled on the drafting team.
alter table players add column if not exists positions text[] not null default '{}';

-- Migration (2026-07-19): two new reminder email types, now that real sending
-- is wired up (src/lib/email/send-mail.ts, Gmail SMTP) instead of dry-run-only.
-- 'registration_filled' fires the instant a game hits capacity and includes
-- the roster in its body; 'lineup_ready' fires once a live draft session
-- completes and includes both teams' final rosters. Verify the actual
-- constraint name first (should be the Postgres-default
-- "reminder_email_log_email_type_check" for this table's original unnamed
-- inline CHECK) before dropping, same caution as the players_status_check
-- migration above:
--   select conname from pg_constraint
--   where conrelid = 'reminder_email_log'::regclass and contype = 'c';
alter table reminder_email_log drop constraint reminder_email_log_email_type_check;
alter table reminder_email_log add constraint reminder_email_log_email_type_check
  check (email_type in ('registration_open', 'closing_soon', 'registration_filled', 'lineup_ready'));

-- Migration (2026-08-08): pre-draft balance. Confirmed real, recurring case
-- (draft-2026-08-08-saturday): to balance a lopsided pool, a captain
-- sometimes hands one specific player straight to each side before the snake
-- draft starts. Previously that player just got drafted as a normal pick
-- (usually the very last one), quietly corrupting their avgDraftPosition —
-- see draft_sessions' own doc comment above for the intended treatment
-- (same as a captain: real roster member, never a real pick).
alter table draft_sessions add column if not exists home_balance_canonical_ids text[] not null default '{}';
alter table draft_sessions add column if not exists away_balance_canonical_ids text[] not null default '{}';

-- Migration (2026-10-16): game review status + score derived from goal_events.
-- Run from supabase/migrations/2026-10-16_game_review_status.sql (which also
-- holds a one-off fix for 2026-10-11-sunday); mirrored here without that fix.
alter table game_records add column if not exists status text not null default 'published'
  check (status in ('published', 'pending_review'));
alter table game_records add column if not exists review_reason text;
alter table game_records add column if not exists stated_home_score integer;
alter table game_records add column if not exists stated_away_score integer;
