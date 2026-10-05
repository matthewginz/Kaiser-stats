import { redactReportText } from "../format";
import { createServiceRoleClient } from "../supabase/client";
import { fetchAllRows } from "../supabase/paginate";
import type { Position } from "./positions";
import type { GameRecord, League, PlayerIdentity, SeasonStandingRow } from "./types";

/**
 * The real-data query layer described in docs/data-contract.md's "Going
 * live with real data" section: fetches rows from Supabase and hands them
 * to the existing, tested TypeScript aggregation functions
 * (aggregateStandings()/rollupGameRecords()), the same way the sample-data
 * pages ran data/sample/ through them before this. Same "pure mapper, thin
 * I/O wrapper" split as buildScheduledGames/listScheduledGames in
 * src/lib/matchday/data.ts.
 */

interface PlayerRow {
  canonical_id: string;
  display_name: string;
  roster_name: string | null;
  positions: string[] | null;
  aliases: string[] | null;
  known_emails: string[] | null;
  leagues: string[] | null;
  status: PlayerIdentity["status"];
}

const PLAYER_COLUMNS = "canonical_id, display_name, roster_name, positions, aliases, known_emails, leagues, status";

export function buildPlayerIdentities(rows: PlayerRow[]): PlayerIdentity[] {
  return rows.map((row) => ({
    canonicalId: row.canonical_id,
    displayName: row.display_name,
    rosterName: row.roster_name,
    positions: (row.positions ?? []) as Position[],
    aliases: row.aliases ?? [],
    knownEmails: row.known_emails ?? [],
    leagues: (row.leagues ?? []) as League[],
    status: row.status,
  }));
}

export async function listPlayers(): Promise<PlayerIdentity[]> {
  const client = createServiceRoleClient();
  const rows = await fetchAllRows<PlayerRow>(client, "players", PLAYER_COLUMNS);
  return buildPlayerIdentities(rows);
}

interface SeasonStandingDbRow {
  source: string;
  league: League;
  player_name_raw: string;
  games: number;
  wins: number;
  losses: number;
  ties: number;
  goals: number | null;
  plus_minus: number | null;
  percent: number | null;
  points: number | null;
}

const SEASON_STANDING_ROW_COLUMNS =
  "source, league, player_name_raw, games, wins, losses, ties, goals, plus_minus, percent, points";

export function buildSeasonStandingRows(rows: SeasonStandingDbRow[]): SeasonStandingRow[] {
  return rows.map((row) => ({
    source: row.source,
    league: row.league,
    playerNameRaw: row.player_name_raw,
    games: row.games,
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    goals: row.goals,
    plusMinus: row.plus_minus,
    percent: row.percent,
    points: row.points,
  }));
}

export async function listSeasonStandingRows(): Promise<SeasonStandingRow[]> {
  const client = createServiceRoleClient();
  const rows = await fetchAllRows<SeasonStandingDbRow>(client, "season_standing_rows", SEASON_STANDING_ROW_COLUMNS);
  return buildSeasonStandingRows(rows);
}

interface GameRecordDbRow {
  game_id: string;
  date: string;
  league: League;
  home_team_label: string;
  away_team_label: string;
  home_score: number | null;
  away_score: number | null;
  mvp_canonical_id: string | null;
  description: string | null;
  source: string;
}

interface RosterSpotDbRow {
  game_id: string;
  canonical_id: string;
  side: "home" | "away";
  pick_number: number | null;
}

interface GoalEventDbRow {
  game_id: string;
  scorer_canonical_id: string;
  assist_canonical_id: string | null;
  team: "home" | "away";
}

interface NotableMentionDbRow {
  game_id: string;
  canonical_id: string;
  quote: string;
}

const GAME_RECORD_COLUMNS =
  "game_id, date, league, home_team_label, away_team_label, home_score, away_score, mvp_canonical_id, description, source";
const ROSTER_SPOT_COLUMNS = "game_id, canonical_id, side, pick_number";
const GOAL_EVENT_COLUMNS = "game_id, scorer_canonical_id, assist_canonical_id, team";
const NOTABLE_MENTION_COLUMNS = "game_id, canonical_id, quote";

/**
 * Inverse of buildPersistenceRows() in src/lib/report-parser/persist.ts —
 * regroups the four flat per-game tables back into one GameRecord per game.
 */
/** Groups rows by game_id once, up front — O(rows), instead of every game re-scanning the entire array (see buildGameRecords). */
function groupByGameId<T extends { game_id: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const forGame = grouped.get(row.game_id) ?? [];
    forGame.push(row);
    grouped.set(row.game_id, forGame);
  }
  return grouped;
}

export function buildGameRecords(
  gameRows: GameRecordDbRow[],
  rosterRows: RosterSpotDbRow[],
  goalRows: GoalEventDbRow[],
  mentionRows: NotableMentionDbRow[],
): GameRecord[] {
  const rosterByGame = groupByGameId(rosterRows);
  const goalsByGame = groupByGameId(goalRows);
  const mentionsByGame = groupByGameId(mentionRows);

  return gameRows.map((row) => {
    const roster = rosterByGame.get(row.game_id) ?? [];
    const goals = goalsByGame.get(row.game_id) ?? [];
    const mentions = mentionsByGame.get(row.game_id) ?? [];

    return {
      gameId: row.game_id,
      date: row.date,
      league: row.league,
      homeRoster: roster
        .filter((r) => r.side === "home")
        .map((r) => ({ canonicalId: r.canonical_id, pickNumber: r.pick_number })),
      awayRoster: roster
        .filter((r) => r.side === "away")
        .map((r) => ({ canonicalId: r.canonical_id, pickNumber: r.pick_number })),
      homeTeamLabel: row.home_team_label,
      awayTeamLabel: row.away_team_label,
      homeScore: row.home_score,
      awayScore: row.away_score,
      goals: goals.map((g) => ({
        scorerCanonicalId: g.scorer_canonical_id,
        assistCanonicalId: g.assist_canonical_id,
        team: g.team,
      })),
      mvpCanonicalId: row.mvp_canonical_id,
      notableMentions: mentions.map((m) => ({ canonicalId: m.canonical_id, quote: redactReportText(m.quote) })),
      description: row.description ? redactReportText(row.description) : undefined,
      source: row.source,
    };
  });
}

interface SeasonStatsCutoffDbRow {
  year: number;
  cutoff_date: string;
}

/** See season_stats_cutoff's doc comment in supabase/schema.sql. */
export async function listSeasonStatsCutoffs(): Promise<Map<number, string>> {
  const client = createServiceRoleClient();
  const { data } = await client.from("season_stats_cutoff").select("year, cutoff_date");
  return new Map((data as SeasonStatsCutoffDbRow[] | null ?? []).map((row) => [row.year, row.cutoff_date]));
}

export async function listGameRecords(): Promise<GameRecord[]> {
  const client = createServiceRoleClient();
  const [gameRows, rosterRows, goalRows, mentionRows] = await Promise.all([
    fetchAllRows<GameRecordDbRow>(client, "game_records", GAME_RECORD_COLUMNS, "date"),
    fetchAllRows<RosterSpotDbRow>(client, "roster_spots", ROSTER_SPOT_COLUMNS, "id"),
    fetchAllRows<GoalEventDbRow>(client, "goal_events", GOAL_EVENT_COLUMNS, "id"),
    fetchAllRows<NotableMentionDbRow>(client, "notable_mentions", NOTABLE_MENTION_COLUMNS, "id"),
  ]);
  return buildGameRecords(gameRows, rosterRows, goalRows, mentionRows);
}
