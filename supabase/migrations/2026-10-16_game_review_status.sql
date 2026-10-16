-- Migration (2026-10-16): game review status + score derived from goal_events.
-- Paste into the Supabase SQL Editor and run BEFORE pushing the matching code.
--
-- Safe to run before the new code deploys: it only ADDS columns (three
-- nullable, one NOT NULL with a constant default, which stamps every existing
-- row 'published', i.e. exactly today's visibility) plus one guarded one-off
-- fix. The currently deployed code never selects or writes these columns, so
-- it keeps working, and its inserts get status = 'published' by default.
-- Re-running is a no-op (if not exists + the one-off fix's guard).

begin;

-- 'pending_review' = the report's stated final score disagreed with the goal
-- events (or no score was stated). Hidden from every public page until an
-- admin saves the game from Edit match (see listGameRecords / updateMatch).
alter table game_records add column if not exists status text not null default 'published'
  check (status in ('published', 'pending_review'));
-- Why a game was held for review. Kept as history after an admin publishes it.
alter table game_records add column if not exists review_reason text;
-- Gemini's stated final score, kept only as a cross-check. home_score /
-- away_score are now derived by counting goal_events per team.
alter table game_records add column if not exists stated_home_score integer;
alter table game_records add column if not exists stated_away_score integer;

-- ONE-OFF DATA FIX (2026-10-16), not part of the schema change:
-- 2026-10-11-sunday was saved with Gemini's stated 5:3, but its goal_events
-- rows are 6 home / 3 away. Fires only on that exact row and only while its
-- goal_events still count 6:3; expect "UPDATE 1" the first time, 0 after.
update game_records
set home_score = 6, stated_home_score = 5, stated_away_score = 3
where game_id = '2026-10-11-sunday'
  and home_score = 5
  and away_score = 3
  and (select count(*) from goal_events where game_id = '2026-10-11-sunday' and team = 'home') = 6
  and (select count(*) from goal_events where game_id = '2026-10-11-sunday' and team = 'away') = 3;

commit;
