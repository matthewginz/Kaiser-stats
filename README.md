# Kaiser-stats

LLM-powered stats tracker for a recurring pickup soccer league.

**Live site:** https://kaiser-stats.vercel.app

The live site serves real league data: standings, player profiles and match
history for 100+ players across the 2022–2026 seasons. New games arrive every
week without manual entry. The league organizer's recap emails are parsed by
an LLM and written to the database on a schedule.

## How it works

- **Weekly ingest.** A scheduled job runs every Tuesday. It pulls the
  organizer's recap emails from Gmail, including the full reply thread where
  corrections usually land, and runs `npm run backfill-reports`. That script
  parses each recap into a `GameRecord` with Gemini, then writes it to
  Supabase. Re-runs are idempotent. The job only writes a game that has a real
  recap email; days without one are skipped, never invented.
- **Report parser** (`src/lib/report-parser/`). It turns recap text into a
  score, rosters, goals/assists and an MVP. It checks that the goals add up to
  the score. Names it can't match go to an admin review queue instead of being
  guessed. Admins can also paste a report in through the site, and they can
  edit or delete any saved match. See
  [`docs/report-parsing.md`](docs/report-parsing.md).
- **Stats engine** (`src/lib/stats-engine/`).
  - Player identity resolution. It never auto-merges a fuzzy name match.
  - A header-based parser for the historical season spreadsheets, whose column
    layouts change from year to year.
  - Per-player aggregation across the Saturday, Sunday and merged views.
  - A plus-minus sanity check.
  - A disclosed power-ranking formula with a minimum-games floor. The
    `/rules` page explains every stat.
- **Matchday** (`src/lib/matchday/`). Weekly check-in windows and a live
  snake draft for the captains.
- **Accounts.** Supabase auth. Each account links to a player record, and
  admins get extra permissions. There is also a club chat.

See [`docs/data-contract.md`](docs/data-contract.md) for the shared data shapes
(`PlayerSeasonStats`, `GameRecord`). Both the spreadsheet backfill and the
report parser produce these shapes.

## Running it

```
npm install
cp .env.example .env.local   # fill in Supabase + Gemini keys
npm test
npm run dev                  # localhost:3000
```

Setting up the database is covered in
[`docs/supabase-setup.md`](docs/supabase-setup.md). `data/sample/` holds a
small fake dataset that the unit tests use.

## Privacy

Real player names, emails and stats live only in the private Supabase
database. They are never committed to this repo. Raw recap files go in the
gitignored `private/` folder. See `kaiser_BUILD_SPEC.md` for the full design
and privacy policy. `PHASE_2_HANDOFF.md` maps the infrastructure.
