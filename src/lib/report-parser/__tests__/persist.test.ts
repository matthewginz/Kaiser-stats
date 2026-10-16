import { describe, expect, it } from "vitest";
import { buildPersistenceRows } from "../persist";
import type { GameRecord } from "../../stats-engine/types";

const gameRecord: GameRecord = {
  gameId: "report-2026-07-05-sunday",
  date: "2026-07-05",
  league: "sunday",
  homeRoster: [
    { canonicalId: "p1", pickNumber: 1 },
    { canonicalId: "p2", pickNumber: 3 },
  ],
  awayRoster: [{ canonicalId: "p3", pickNumber: null }],
  homeTeamLabel: "Orange",
  awayTeamLabel: "Blue",
  homeScore: 2,
  awayScore: 1,
  goals: [
    { scorerCanonicalId: "p1", assistCanonicalId: "p2", team: "home" },
    { scorerCanonicalId: "p3", assistCanonicalId: null, team: "away" },
  ],
  mvpCanonicalId: "p1",
  notableMentions: [{ canonicalId: "p2", quote: "Dominant on both ends." }],
  description: "Full pasted report text.",
  source: "manual:2026-07-05-sunday",
};

describe("buildPersistenceRows", () => {
  it("maps the game record row, including null pickNumber and null mvp/description passthrough", () => {
    const { gameRecordRow } = buildPersistenceRows(gameRecord);
    expect(gameRecordRow).toEqual({
      game_id: "report-2026-07-05-sunday",
      date: "2026-07-05",
      league: "sunday",
      home_team_label: "Orange",
      away_team_label: "Blue",
      home_score: 2,
      away_score: 1,
      // Unset on the record (e.g. a draft-created game): no stated score, published.
      stated_home_score: null,
      stated_away_score: null,
      status: "published",
      review_reason: null,
      mvp_canonical_id: "p1",
      description: "Full pasted report text.",
      source: "manual:2026-07-05-sunday",
    });
  });

  it("defaults a missing description to null", () => {
    const { gameRecordRow } = buildPersistenceRows({ ...gameRecord, description: undefined });
    expect(gameRecordRow.description).toBeNull();
  });

  it("combines home and away roster spots with their side tag, preserving null pick numbers", () => {
    const { rosterSpotRows } = buildPersistenceRows(gameRecord);
    expect(rosterSpotRows).toEqual([
      { game_id: "report-2026-07-05-sunday", canonical_id: "p1", side: "home", pick_number: 1 },
      { game_id: "report-2026-07-05-sunday", canonical_id: "p2", side: "home", pick_number: 3 },
      { game_id: "report-2026-07-05-sunday", canonical_id: "p3", side: "away", pick_number: null },
    ]);
  });

  it("maps goal events, preserving a null assist", () => {
    const { goalEventRows } = buildPersistenceRows(gameRecord);
    expect(goalEventRows).toEqual([
      { game_id: "report-2026-07-05-sunday", scorer_canonical_id: "p1", assist_canonical_id: "p2", team: "home" },
      { game_id: "report-2026-07-05-sunday", scorer_canonical_id: "p3", assist_canonical_id: null, team: "away" },
    ]);
  });

  it("maps notable mentions", () => {
    const { notableMentionRows } = buildPersistenceRows(gameRecord);
    expect(notableMentionRows).toEqual([
      { game_id: "report-2026-07-05-sunday", canonical_id: "p2", quote: "Dominant on both ends." },
    ]);
  });

  it("returns empty arrays for a game with no goals/mentions/rosters", () => {
    const empty = buildPersistenceRows({
      ...gameRecord,
      homeRoster: [],
      awayRoster: [],
      goals: [],
      notableMentions: [],
    });
    expect(empty.rosterSpotRows).toEqual([]);
    expect(empty.goalEventRows).toEqual([]);
    expect(empty.notableMentionRows).toEqual([]);
  });
});
