import type { GameRecord, GameStatus } from "../stats-engine/types";

export interface GameRecordRow {
  game_id: string;
  date: string;
  league: string;
  home_team_label: string;
  away_team_label: string;
  home_score: number | null;
  away_score: number | null;
  stated_home_score: number | null;
  stated_away_score: number | null;
  status: GameStatus;
  review_reason: string | null;
  mvp_canonical_id: string | null;
  description: string | null;
  source: string;
}

export interface RosterSpotRow {
  game_id: string;
  canonical_id: string;
  side: "home" | "away";
  pick_number: number | null;
}

export interface GoalEventRow {
  game_id: string;
  scorer_canonical_id: string;
  assist_canonical_id: string | null;
  team: "home" | "away";
}

export interface NotableMentionRow {
  game_id: string;
  canonical_id: string;
  quote: string;
}

/**
 * Pure mapper from a resolved GameRecord (camelCase, in-memory) to the
 * snake_case row shapes matching supabase/schema.sql — same "pure mapper,
 * thin I/O wrapper" split as buildScheduledGames/listScheduledGames in
 * src/lib/matchday/data.ts. The actual Supabase writes live in actions.ts.
 */
export function buildPersistenceRows(gameRecord: GameRecord): {
  gameRecordRow: GameRecordRow;
  rosterSpotRows: RosterSpotRow[];
  goalEventRows: GoalEventRow[];
  notableMentionRows: NotableMentionRow[];
} {
  const gameRecordRow: GameRecordRow = {
    game_id: gameRecord.gameId,
    date: gameRecord.date,
    league: gameRecord.league,
    home_team_label: gameRecord.homeTeamLabel,
    away_team_label: gameRecord.awayTeamLabel,
    home_score: gameRecord.homeScore,
    away_score: gameRecord.awayScore,
    stated_home_score: gameRecord.statedHomeScore ?? null,
    stated_away_score: gameRecord.statedAwayScore ?? null,
    status: gameRecord.status ?? "published",
    review_reason: gameRecord.reviewReason ?? null,
    mvp_canonical_id: gameRecord.mvpCanonicalId,
    description: gameRecord.description ?? null,
    source: gameRecord.source,
  };

  const rosterSpotRows: RosterSpotRow[] = [
    ...gameRecord.homeRoster.map((spot) => ({
      game_id: gameRecord.gameId,
      canonical_id: spot.canonicalId,
      side: "home" as const,
      pick_number: spot.pickNumber,
    })),
    ...gameRecord.awayRoster.map((spot) => ({
      game_id: gameRecord.gameId,
      canonical_id: spot.canonicalId,
      side: "away" as const,
      pick_number: spot.pickNumber,
    })),
  ];

  const goalEventRows: GoalEventRow[] = gameRecord.goals.map((goal) => ({
    game_id: gameRecord.gameId,
    scorer_canonical_id: goal.scorerCanonicalId,
    assist_canonical_id: goal.assistCanonicalId,
    team: goal.team,
  }));

  const notableMentionRows: NotableMentionRow[] = gameRecord.notableMentions.map((mention) => ({
    game_id: gameRecord.gameId,
    canonical_id: mention.canonicalId,
    quote: mention.quote,
  }));

  return { gameRecordRow, rosterSpotRows, goalEventRows, notableMentionRows };
}
