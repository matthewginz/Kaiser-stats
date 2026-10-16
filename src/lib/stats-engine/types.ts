import type { Position } from "./positions";

export type League = "saturday" | "sunday" | "unknown";

export type StatsView = "saturday" | "sunday" | "merged";

export interface PlayerIdentity {
  canonicalId: string;
  displayName: string;
  /**
   * The name used in game reports — how a live-draft captain would
   * recognize this player. Undefined/null for anyone who hasn't logged in
   * and set it themselves at onboarding (or been given one by an admin), and
   * for every construction site that doesn't deal in real Supabase rows
   * (sample data, report-parser extraction, tests) — see rosterDisplayName()
   * in identity.ts for the null-safe fallback used wherever this matters
   * (the live draft).
   */
  rosterName?: string | null;
  /**
   * Positions this player can play, self-selected at onboarding (or set by an
   * admin on their behalf) — see src/lib/stats-engine/positions.ts for the 9
   * valid codes. Undefined/empty for anyone who hasn't set it, or for every
   * construction site that doesn't deal in real Supabase rows (sample data,
   * report-parser extraction, tests). The live draft's positional-need logic
   * (src/lib/matchday/position-need.ts) treats "unset" as neutral, never as
   * a strike against a player.
   */
  positions?: Position[];
  aliases: string[];
  knownEmails: string[];
  leagues: League[];
  /**
   * "provisional" = auto-created from a spreadsheet/report name that had no
   * fuzzy match to anything else known (see createProvisionalIdentity in
   * identity.ts) — a stable placeholder identity, not yet confirmed with a
   * real full name/email. Stats accumulate under it immediately; a human
   * can later fold it into a confirmed identity by adding the raw name as
   * an alias in kaiser_player_identity.csv.
   */
  status: "regular" | "guest" | "deferred" | "example" | "provisional";
}

/**
 * One row of a season-standings sheet, normalized from a source spreadsheet.
 * Spreadsheet column sets vary year to year (see kaiser_stats_engine_notes.md) —
 * this shape is the intersection every year actually has.
 */
export interface SeasonStandingRow {
  source: string;
  league: League;
  playerNameRaw: string;
  games: number;
  wins: number;
  losses: number;
  ties: number;
  goals: number | null;
  plusMinus: number | null;
  percent: number | null;
  points: number | null;
}

export interface NameResolution {
  raw: string;
  status: "exact" | "flagged" | "unresolved";
  canonicalId: string | null;
  candidates: { canonicalId: string; displayName: string; distance: number }[];
}

/**
 * The stable data contract: "one player's aggregated stats, in their final
 * clean form" — regardless of which messy source produced them. Both ingestion
 * paths converge here:
 *   - historical season-standings spreadsheets -> aggregateStandings() (aggregate.ts)
 *   - future per-game report parsing -> GameRecord[] -> rollupGameRecords() (game-records.ts)
 * See docs/data-contract.md for the full field-by-field explanation.
 *
 * `assists`, `mvpCount`, `avgDraftPosition`, and `notableMentions` only ever
 * come from the GameRecord path — the historical spreadsheets never tracked
 * any of them (assists/MVP confirmed absent in all 5 years, see
 * kaiser_stats_engine_notes.md; draft position and report narrative simply
 * don't exist at season-aggregate granularity). Spreadsheet-only aggregates
 * report `assists`/`mvpCount` as 0, `avgDraftPosition` as null, and
 * `notableMentions` as an empty array, rather than omitting the fields.
 */
export interface PlayerSeasonStats {
  canonicalId: string;
  displayName: string;
  /** See PlayerIdentity.rosterName's doc comment — same null-safe fallback via rosterDisplayName(). */
  rosterName?: string | null;
  games: number;
  wins: number;
  losses: number;
  ties: number;
  goals: number;
  assists: number;
  plusMinus: number;
  mvpCount: number;
  /**
   * Average snake-draft pick number across every game this player was
   * actually drafted in (1 = picked first that game), or null if never
   * drafted / unknown. A game where this player was that team's captain
   * (roster[0] — see prompt.ts rule 10) never contributes here, even though
   * they still played: the captain's own "pick number" is always a
   * structural stand-in (home captain always 1, away captain always 2 —
   * see resolveExtractionToGameRecord in parse-report.ts), never a real
   * draft decision, so it would silently drag this average toward 1-2 for
   * anyone who frequently captains, with no bearing on how early they're
   * actually valued as a pick (confirmed as a real, visible distortion —
   * see rollupGameRecords in game-records.ts). Display-only regardless — see
   * kaiser_BUILD_SPEC.md on why draft position must never be a ranking
   * *input* (it encodes the captains' priors, not performance): it's shown
   * alongside the performance rank as a value-over-draft-position
   * comparison, the same way fantasy sports compares performance to ADP,
   * never folded into the rank itself.
   */
  avgDraftPosition: number | null;
  /**
   * Verbatim narrative snippets from report text that mention this player
   * (e.g. a standout zero-goal performance). Qualitative context only, same
   * reasoning as assists: mentions are sparse and inconsistent (only appear
   * when a report happens to narrate a moment), so using them as a scored
   * ranking input would reward whoever got a sentence, not whoever played
   * well. Never fed into mvpCount or the power ranking.
   */
  notableMentions: string[];
  sources: string[];
}

export interface PlusMinusMismatch {
  source: string;
  playerNameRaw: string;
  wins: number;
  losses: number;
  statedPlusMinus: number;
  expectedPlusMinus: number;
}

export type GameStatus = "published" | "pending_review";

/** One goal, as it will be extracted from a report by the future LLM parser. */
export interface GoalEvent {
  scorerCanonicalId: string;
  assistCanonicalId: string | null;
  team: "home" | "away";
}

/** One roster spot: who, and which overall snake-draft pick number got them. */
export interface RosterSpot {
  canonicalId: string;
  /**
   * 1-indexed overall pick number for this game's draft (not per-team), or
   * null when it isn't known. Report-parsed games compute this by default
   * (see resolveExtractionToGameRecord in parse-report.ts): the team listed
   * first is assumed to have picked first, alternating strict snake order —
   * a confirmed league convention (each roster's first-listed player is
   * that team's captain, the rest of the list is already in draft order),
   * refined further when a report narrates the real order or a human
   * supplies a "First pick" annotation. A captain (roster[0]) always keeps
   * this null — they choose, they aren't chosen, so they're never part of
   * the numbered sequence at all (confirmed 2026-07-16: an earlier version
   * reserved pick 1/2 for the two captains, which inflated every real pick's
   * number). Otherwise only left null when something about that game's data
   * is inconsistent enough not to trust (see
   * firstPickWarning/pickOrderWarning). Historical spreadsheet-backfilled
   * games (which predate any of this) still leave it null; rollupGameRecords()
   * simply skips null values when averaging avgDraftPosition.
   */
  pickNumber: number | null;
}

/** A verbatim report-narrative snippet naming a player, for a single game. */
export interface NotableMention {
  canonicalId: string;
  quote: string;
}

/**
 * The stable data contract: "one game's worth of data," in its final clean
 * form. This is the shape the future LLM report-parser is expected to
 * produce — name resolution against the identity table has already happened
 * by the time a GameRecord exists, so every player reference here is a
 * canonicalId, never raw report text. See docs/data-contract.md.
 */
export interface GameRecord {
  gameId: string;
  date: string; // ISO 8601, e.g. "2026-07-05"
  league: League;
  homeRoster: RosterSpot[];
  awayRoster: RosterSpot[];
  /**
   * "Home"/"away" has no real meaning for this pickup league — these are
   * the actual team names to show (e.g. "Orange"/"Blue"). Populated from
   * the report when it names sides, from RawExtraction's
   * homeTeamLabelRaw/awayTeamLabelRaw; when the report doesn't name sides,
   * resolveExtractionToGameRecord() applies a plain default ("Orange"/
   * "Blue") rather than leaving this null — unlike a player identity, a
   * wrong guess here can't misattribute anyone's stats, it's just a label,
   * so a default is fine where a guess elsewhere in this file wouldn't be.
   */
  homeTeamLabel: string;
  awayTeamLabel: string;
  /**
   * Null when a team-split roster is known (players really played) but no
   * one ever emailed a final score/report — a real, permanent gap (see
   * "no report" games in the backfill), not a parsing failure. Always
   * both-null-or-both-set together.
   */
  homeScore: number | null;
  awayScore: number | null;
  /**
   * The report's own stated final score, kept only as a cross-check —
   * homeScore/awayScore are derived from `goals` (see
   * resolveExtractionToGameRecord). Undefined/null for draft-created games
   * and anything saved before 2026-10-16.
   */
  statedHomeScore?: number | null;
  statedAwayScore?: number | null;
  /** Undefined means "published". A pending_review game is hidden from every public page (see listGameRecords). */
  status?: GameStatus;
  /** Why the game was held for review. Kept as history even after an admin publishes it. */
  reviewReason?: string | null;
  goals: GoalEvent[];
  /** App-derived MVP call for this game, or null if not yet computed. */
  mvpCanonicalId: string | null;
  /**
   * Report-narrative snippets mentioning a player, kept separate from
   * mvpCanonicalId — see PlayerSeasonStats.notableMentions for why these are
   * qualitative context, never a ranking input.
   */
  notableMentions: NotableMention[];
  /**
   * Admin-pasted free-text summary of the game (originally lifted from the
   * league organizer's report message). Optional — no admin-editing UI
   * exists yet, so this is only ever populated by hand in sample/seed data
   * for now.
   */
  description?: string;
  /** Provenance, e.g. "email:19f3315cf733a148" or "spreadsheet:soccer_2023.xlsx#Sheet1". */
  source: string;
}
