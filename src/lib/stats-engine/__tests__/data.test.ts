import { describe, expect, it } from "vitest";
import { buildGameRecords } from "../data";

const gameRow = (gameId: string, status: "published" | "pending_review") => ({
  game_id: gameId,
  date: "2026-10-11",
  league: "sunday" as const,
  home_team_label: "Orange",
  away_team_label: "Blue",
  home_score: 1,
  away_score: 0,
  mvp_canonical_id: null,
  description: null,
  source: `email:${gameId}`,
  status,
});

const goalRows = [
  { game_id: "published-game", scorer_canonical_id: "p1", assist_canonical_id: null, team: "home" as const },
  { game_id: "pending-game", scorer_canonical_id: "p1", assist_canonical_id: null, team: "home" as const },
];

describe("buildGameRecords", () => {
  const gameRows = [gameRow("published-game", "published"), gameRow("pending-game", "pending_review")];

  it("hides pending_review games (and their goals) from public reads by default", () => {
    const games = buildGameRecords(gameRows, [], goalRows, []);
    expect(games.map((g) => g.gameId)).toEqual(["published-game"]);
    expect(games[0]?.goals).toHaveLength(1);
  });

  it("includes pending_review games only when asked (admin edit page)", () => {
    const games = buildGameRecords(gameRows, [], goalRows, [], { includePending: true });
    expect(games.map((g) => [g.gameId, g.status])).toEqual([
      ["published-game", "published"],
      ["pending-game", "pending_review"],
    ]);
  });
});
