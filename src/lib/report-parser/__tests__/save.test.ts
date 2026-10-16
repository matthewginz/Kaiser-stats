import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { saveResolvedGame } from "../save";
import type { GameRecord } from "../../stats-engine/types";

// Records every insert per table; game_records' insert returns `gameRecordError`.
function fakeClient(gameRecordError: { code: string } | null) {
  const inserts: Record<string, unknown[]> = {};
  const client = {
    from: (table: string) => ({
      insert: async (rows: unknown) => {
        (inserts[table] ??= []).push(rows);
        return { error: table === "game_records" ? gameRecordError : null };
      },
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  };
  return { client: client as unknown as SupabaseClient, inserts };
}

const gameRecord: GameRecord = {
  gameId: "2026-10-11-sunday",
  date: "2026-10-11",
  league: "sunday",
  homeRoster: [{ canonicalId: "p1", pickNumber: null }],
  awayRoster: [{ canonicalId: "p2", pickNumber: null }],
  homeTeamLabel: "Orange",
  awayTeamLabel: "Blue",
  homeScore: 1,
  awayScore: 0,
  statedHomeScore: 2,
  statedAwayScore: 0,
  status: "pending_review",
  reviewReason: "Stated score 2:0, but goal events add up to 1:0.",
  goals: [{ scorerCanonicalId: "p1", assistCanonicalId: null, team: "home" }],
  mvpCanonicalId: null,
  notableMentions: [],
  source: "email:2026-10-11-sunday",
};

const params = { gameRecord, provisionedPlayers: [], flaggedNames: [], rawText: "report" };

describe("saveResolvedGame", () => {
  it("skips a rerun of an existing game_id: duplicate-key error, nothing else written", async () => {
    const { client, inserts } = fakeClient({ code: "23505" });
    const result = await saveResolvedGame(client, params);
    expect(result).toEqual({ ok: false, error: "A match report already exists for that date/league." });
    expect(Object.keys(inserts)).toEqual(["game_records"]);
  });

  it("writes the derived score, stated score, and pending_review status on a fresh save", async () => {
    const { client, inserts } = fakeClient(null);
    const result = await saveResolvedGame(client, params);
    expect(result).toEqual({ ok: true });
    expect(inserts.game_records?.[0]).toMatchObject({
      home_score: 1,
      away_score: 0,
      stated_home_score: 2,
      stated_away_score: 0,
      status: "pending_review",
      review_reason: "Stated score 2:0, but goal events add up to 1:0.",
    });
    expect(inserts.goal_events?.[0]).toHaveLength(1);
  });
});
