import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractFirstPickAnnotation, parseReportText, resolveExtractionToGameRecord, stripGmailChrome } from "../parse-report";
import { callGemini } from "../gemini-client";
import { NEW_PLAYER_RESOLUTION, type RawExtraction } from "../types";
import type { PlayerIdentity } from "../../stats-engine/types";

vi.mock("../gemini-client", () => ({ callGemini: vi.fn() }));
const mockedCallGemini = vi.mocked(callGemini);

const players: PlayerIdentity[] = [
  { canonicalId: "p1", displayName: "Ari Fox", aliases: [], knownEmails: [], leagues: ["sunday"], status: "regular" },
  { canonicalId: "p2", displayName: "Bex Tanaka", aliases: [], knownEmails: [], leagues: ["sunday"], status: "regular" },
  { canonicalId: "p3", displayName: "Cy Okafor", aliases: [], knownEmails: [], leagues: ["sunday"], status: "regular" },
];

const meta = {
  gameId: "test-game",
  source: "email:test-thread",
  fallbackDate: "2026-01-01",
  fallbackLeague: "sunday" as const,
};

describe("resolveExtractionToGameRecord", () => {
  it("resolves exact names to canonicalIds and computes the goal-sum check correctly", () => {
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: ["Ari Fox", "Bex Tanaka"],
      awayRosterRaw: ["Cy Okafor"],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 2,
      awayScore: 1,
      goals: [
        { scorerRaw: "Ari Fox", assistRaw: "Bex Tanaka", team: "home" },
        { scorerRaw: "Ari Fox", assistRaw: null, team: "home" },
        { scorerRaw: "Cy Okafor", assistRaw: null, team: "away" },
      ],
      mvpRaw: "Ari Fox",
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta);
    // p1 is home's captain (roster[0]) -- never numbered; p2 is the first real pick.
    expect(result.gameRecord.homeRoster).toEqual([
      { canonicalId: "p1", pickNumber: null },
      { canonicalId: "p2", pickNumber: 1 },
    ]);
    expect(result.gameRecord.mvpCanonicalId).toBe("p1");
    expect(result.goalSumMismatch).toBe(false);
    expect(result.provisionedPlayers).toHaveLength(0);
    expect(result.flaggedNames).toHaveLength(0);
    expect(result.gameRecord.homeTeamLabel).toBe("Orange");
    expect(result.gameRecord.awayTeamLabel).toBe("Blue");
  });

  it("uses the report's own stated team names instead of the Orange/Blue default when given", () => {
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: [],
      awayRosterRaw: [],
      homeTeamLabelRaw: "Orange",
      awayTeamLabelRaw: "Blue",
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta);
    expect(result.gameRecord.homeTeamLabel).toBe("Orange");
    expect(result.gameRecord.awayTeamLabel).toBe("Blue");
  });

  it("leaves every pick number null (not just captains') for a report that names both sides — that listing isn't confirmed draft order (real June 27 game)", () => {
    const extraction: RawExtraction = {
      date: "2026-06-27",
      league: "saturday",
      homeRosterRaw: ["Ari Fox", "Bex Tanaka"],
      awayRosterRaw: ["Cy Okafor", "Dana Petrov"],
      homeTeamLabelRaw: "Orange",
      awayTeamLabelRaw: "Blue",
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta);
    expect(result.gameRecord.homeRoster.every((s) => s.pickNumber === null)).toBe(true);
    expect(result.gameRecord.awayRoster.every((s) => s.pickNumber === null)).toBe(true);
    // Unanswered — the team-label heuristic's own guess is reported back for the UI to show.
    expect(result.rosterOrderIsDraftOrder).toBe(false);
  });

  it("a human's explicit rosterOrderIsDraftOrderOverride wins outright, either direction, regardless of team labels", () => {
    // Team-labeled report the heuristic alone would treat as NOT draft order —
    // an explicit `true` override numbers it anyway (a real case: a report
    // names "Team Orange"/"Team Blue" but the listed order genuinely was the
    // draft order this time).
    const labeledExtraction: RawExtraction = {
      date: "2026-06-27",
      league: "saturday",
      homeRosterRaw: ["Ari Fox", "Bex Tanaka"],
      awayRosterRaw: ["Cy Okafor", "Dana Petrov"],
      homeTeamLabelRaw: "Orange",
      awayTeamLabelRaw: "Blue",
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };
    const forcedOn = resolveExtractionToGameRecord(labeledExtraction, players, meta, null, undefined, true);
    expect(forcedOn.rosterOrderIsDraftOrder).toBe(true);
    expect(forcedOn.gameRecord.homeRoster).toEqual([
      { canonicalId: "p1", pickNumber: null },
      { canonicalId: "p2", pickNumber: 1 },
    ]);

    // Unlabeled report the heuristic alone would treat AS draft order — an
    // explicit `false` override suppresses numbering anyway.
    const unlabeledExtraction: RawExtraction = { ...labeledExtraction, homeTeamLabelRaw: null, awayTeamLabelRaw: null };
    const forcedOff = resolveExtractionToGameRecord(unlabeledExtraction, players, meta, null, undefined, false);
    expect(forcedOff.rosterOrderIsDraftOrder).toBe(false);
    expect(forcedOff.gameRecord.homeRoster.every((s) => s.pickNumber === null)).toBe(true);
  });

  it("flags goal-sum mismatches instead of silently trusting the parse", () => {
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: [],
      awayRosterRaw: [],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 3,
      awayScore: 0,
      goals: [{ scorerRaw: "Ari Fox", assistRaw: null, team: "home" }],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta);
    expect(result.goalSumMismatch).toBe(true);
  });

  it("auto-provisions a genuinely novel scorer name instead of dropping the goal", () => {
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: [],
      awayRosterRaw: [],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 1,
      awayScore: 0,
      goals: [{ scorerRaw: "Mystery Guest", assistRaw: null, team: "home" }],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta);
    expect(result.provisionedPlayers).toHaveLength(1);
    expect(result.provisionedPlayers[0]?.displayName).toBe("Mystery Guest");
    expect(result.gameRecord.goals[0]?.scorerCanonicalId).toBe(result.provisionedPlayers[0]?.canonicalId);
  });

  it("excludes a flagged (ambiguous) MVP name rather than guessing which player it is", () => {
    const flaggedPlayers: PlayerIdentity[] = [
      ...players,
      { canonicalId: "p4", displayName: "Gena", aliases: [], knownEmails: [], leagues: ["sunday"], status: "regular" },
    ];
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: [],
      awayRosterRaw: [],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: "Gera", // one edit away from "Gena" — a different, existing player
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, flaggedPlayers, meta);
    expect(result.gameRecord.mvpCanonicalId).toBeNull();
    expect(result.flaggedNames).toHaveLength(1);
    expect(result.flaggedNames[0]?.raw).toBe("Gera");
  });

  it("resolves a flagged name to a human-confirmed player via manualResolutions instead of excluding it — never re-flags it either", () => {
    const flaggedPlayers: PlayerIdentity[] = [
      ...players,
      { canonicalId: "p4", displayName: "Gena", aliases: [], knownEmails: [], leagues: ["sunday"], status: "regular" },
    ];
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: [],
      awayRosterRaw: [],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: "Gera",
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    // Case-insensitive/whitespace-insensitive key, matching how the client
    // re-sends a confirmed name after a re-parse (ReportImportForm's own
    // raw.trim().toLowerCase() key).
    const result = resolveExtractionToGameRecord(extraction, flaggedPlayers, meta, null, { gera: "p4" });
    expect(result.gameRecord.mvpCanonicalId).toBe("p4");
    expect(result.flaggedNames).toHaveLength(0);
  });

  it("provisions a flagged name as a brand-new player when the admin picks 'Add as new player' — never reusing an existing (e.g. retired) id", () => {
    const flaggedPlayers: PlayerIdentity[] = [
      ...players,
      { canonicalId: "p4", displayName: "Gena", aliases: [], knownEmails: [], leagues: ["sunday"], status: "regular" },
      { canonicalId: "auto-gera", displayName: "Old Gera", aliases: [], knownEmails: [], leagues: [], status: "deferred" },
    ];
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: ["Gera"],
      awayRosterRaw: [],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 1,
      awayScore: 0,
      goals: [{ scorerRaw: "Gera", assistRaw: null, team: "home" }],
      mvpRaw: "Gera",
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, flaggedPlayers, meta, null, {
      gera: NEW_PLAYER_RESOLUTION,
    });
    expect(result.flaggedNames).toHaveLength(0);
    expect(result.provisionedPlayers.map((p) => [p.canonicalId, p.displayName])).toEqual([["auto-gera-2", "Gera"]]);
    expect(result.gameRecord.mvpCanonicalId).toBe("auto-gera-2");
    expect(result.gameRecord.homeRoster[0]?.canonicalId).toBe("auto-gera-2");
    expect(result.gameRecord.goals[0]?.scorerCanonicalId).toBe("auto-gera-2");
  });

  it("defaults to alternating pick numbers for every game, even with no annotation at all — captains never numbered", () => {
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: ["Ari Fox", "Bex Tanaka"],
      awayRosterRaw: ["Cy Okafor", "Dana Petrov"],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    // Team listed first (home) is assumed to have picked first — a
    // confirmed league convention, not a guess (see parse-report.ts's
    // resolveExtractionToGameRecord doc comment). Ari Fox/Cy Okafor
    // (roster[0] of each side) are captains — never numbered at all.
    const result = resolveExtractionToGameRecord(extraction, players, meta);
    expect(result.firstPickWarning).toBeNull();
    expect(result.pickOrderWarning).toBeNull();
    expect(result.gameRecord.homeRoster).toEqual([
      { canonicalId: "p1", pickNumber: null },
      { canonicalId: "p2", pickNumber: 1 },
    ]);
    expect(result.gameRecord.awayRoster).toEqual([
      { canonicalId: "p3", pickNumber: null },
      { canonicalId: "auto-dana-petrov", pickNumber: 2 },
    ]);
  });

  it("removes a pre-draft-balance player from the pick sequence entirely, never gap-preserved like a flagged name", () => {
    const extraction: RawExtraction = {
      date: "2026-08-08",
      league: "saturday",
      homeRosterRaw: ["Ari Fox", "Bex Tanaka", "Eli Cruz"],
      awayRosterRaw: ["Cy Okafor"],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: ["Bex Tanaka"],
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta);
    // Bex Tanaka (pre-draft balance) keeps pickNumber null, and — unlike a
    // flagged name's gap — Eli Cruz right after them is still pick 1, not
    // pick 2: their slot never consumed a real draft-turn number at all.
    expect(result.gameRecord.homeRoster).toEqual([
      { canonicalId: "p1", pickNumber: null },
      { canonicalId: "p2", pickNumber: null },
      { canonicalId: "auto-eli-cruz", pickNumber: 1 },
    ]);
  });

  it("handles two pre-draft-balance players on one side, one right after the captain and one at the very end — real picks between them still number consecutively", () => {
    const extraction: RawExtraction = {
      date: "2026-08-08",
      league: "saturday",
      homeRosterRaw: ["Ari Fox", "Bex Tanaka", "Eli Cruz", "Gus Vance", "Ivy Lang"],
      awayRosterRaw: ["Cy Okafor"],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: ["Bex Tanaka", "Ivy Lang"],
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta);
    // Home side numbers odd (1, 3, 5...) by convention — Eli Cruz and Gus
    // Vance are back-to-back real picks (1, 3), completely unaffected by
    // Bex Tanaka before them or Ivy Lang after them.
    expect(result.gameRecord.homeRoster).toEqual([
      { canonicalId: "p1", pickNumber: null },
      { canonicalId: "p2", pickNumber: null },
      { canonicalId: "auto-eli-cruz", pickNumber: 1 },
      { canonicalId: "auto-gus-vance", pickNumber: 3 },
      { canonicalId: "auto-ivy-lang", pickNumber: null },
    ]);
  });

  it("keeps a flagged name's gap in the pick-number sequence instead of shifting everyone after it (real bug, found 2026-07-17)", () => {
    const flaggedPlayers: PlayerIdentity[] = [
      ...players,
      { canonicalId: "p4", displayName: "Gena", aliases: [], knownEmails: [], leagues: ["sunday"], status: "regular" },
    ];
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      // Ari Fox is captain (never numbered). "Gera" is one edit from the
      // existing "Gena" — flagged, excluded entirely. Dana Petrov is listed
      // AFTER the flagged name — this is exactly the case that used to
      // silently shift her pick number down by one.
      homeRosterRaw: ["Ari Fox", "Bex Tanaka", "Gera", "Dana Petrov"],
      awayRosterRaw: [],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, flaggedPlayers, meta);
    expect(result.flaggedNames).toHaveLength(1);
    expect(result.flaggedNames[0]?.raw).toBe("Gera");
    // Bex Tanaka keeps pick 1 (unaffected — listed before the gap). Dana
    // Petrov must get pick 5 (her real original position, 3rd non-captain
    // slot: 2*2+1), NOT pick 3 (what she'd get if the gap were collapsed).
    expect(result.gameRecord.homeRoster).toEqual([
      { canonicalId: "p1", pickNumber: null },
      { canonicalId: "p2", pickNumber: 1 },
      { canonicalId: "auto-dana-petrov", pickNumber: 5 },
    ]);
  });

  it("computes real pick numbers for a game with a confirmed first-pick annotation, overriding the default", () => {
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: ["Bex Tanaka", "Cy Okafor"],
      awayRosterRaw: ["Ari Fox", "Dana Petrov"],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    // Away's captain ("Ari Fox") is confirmed to have picked first — contradicts the default
    // (home listed first). Ari Fox/Bex Tanaka are still captains — never numbered.
    const result = resolveExtractionToGameRecord(extraction, players, meta, "Ari Fox");
    expect(result.firstPickWarning).toBeNull();
    expect(result.gameRecord.awayRoster).toEqual([
      { canonicalId: "p1", pickNumber: null },
      { canonicalId: "auto-dana-petrov", pickNumber: 1 },
    ]);
    expect(result.gameRecord.homeRoster).toEqual([
      { canonicalId: "p2", pickNumber: null },
      { canonicalId: "p3", pickNumber: 2 },
    ]);
  });

  it("leaves pick numbers null and warns when the first-pick annotation matches neither roster", () => {
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: ["Bex Tanaka"],
      awayRosterRaw: ["Cy Okafor"],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: null,
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta, "Ari Fox");
    expect(result.firstPickWarning).toContain("Ari Fox");
    expect(result.gameRecord.homeRoster[0]?.pickNumber).toBeNull();
    expect(result.gameRecord.awayRoster[0]?.pickNumber).toBeNull();
  });

  it("overrides the default with a narrated pick order when the report states one explicitly (real worked example)", () => {
    // Real convention confirmed by the league organizer: first-listed player
    // on each side is that team's captain (not part of the snake sequence);
    // the report narrated "Nick Brazil selected first, then Alan, then Josh,
    // then Emre and Matthew (together), then Oleg" — a non-strictly-
    // alternating order (Emre/Matthew go back-to-back) that the default
    // alone couldn't produce.
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: ["Vadim", "Nick Brazil", "Josh", "Oleg"],
      awayRosterRaw: ["Alik", "Alan", "Emre", "Matthew"],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: ["Nick Brazil", "Alan", "Josh", ["Emre", "Matthew"], "Oleg"],
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta);
    expect(result.pickOrderWarning).toBeNull();
    // Vadim/Alik are captains (roster[0]) — never numbered at all. Real
    // picks start at 1, in the narrated order (Emre/Matthew tied at 4/5).
    expect(result.gameRecord.homeRoster).toEqual([
      { canonicalId: "auto-vadim", pickNumber: null },
      { canonicalId: "auto-nick-brazil", pickNumber: 1 },
      { canonicalId: "auto-josh", pickNumber: 3 },
      { canonicalId: "auto-oleg", pickNumber: 6 },
    ]);
    expect(result.gameRecord.awayRoster).toEqual([
      { canonicalId: "auto-alik", pickNumber: null },
      { canonicalId: "auto-alan", pickNumber: 2 },
      { canonicalId: "auto-emre", pickNumber: 4 },
      { canonicalId: "auto-matthew", pickNumber: 5 },
    ]);
  });

  it("warns but keeps going when the narrated pick order names someone off either roster", () => {
    const extraction: RawExtraction = {
      date: "2026-07-05",
      league: "sunday",
      homeRosterRaw: ["Ari Fox", "Bex Tanaka"],
      awayRosterRaw: ["Cy Okafor"],
      homeTeamLabelRaw: null,
      awayTeamLabelRaw: null,
      homeScore: 0,
      awayScore: 0,
      goals: [],
      mvpRaw: null,
      notableMentions: [],
      pickOrderRaw: ["Someone Else", "Bex Tanaka"],
      preDraftBalanceRaw: null,
    };

    const result = resolveExtractionToGameRecord(extraction, players, meta);
    expect(result.pickOrderWarning).toContain("Someone Else");
    // "Someone Else" (nextPick 1) fails to resolve; "Bex Tanaka" gets nextPick 2.
    expect(result.gameRecord.homeRoster.find((s) => s.canonicalId === "p2")?.pickNumber).toBe(2);
  });
});

describe("parseReportText", () => {
  beforeEach(() => {
    mockedCallGemini.mockReset();
  });

  it("retries once when Gemini returns malformed JSON (the intermittent finishReason-STOP-but-truncated glitch)", async () => {
    const validJson = JSON.stringify({ date: "2026-07-05", league: "sunday" });
    mockedCallGemini.mockResolvedValueOnce('{"date": "2026-07-05", "league": "sunday"').mockResolvedValueOnce(validJson);

    const result = await parseReportText("fake-key", "some report text");
    expect(result).toEqual({ date: "2026-07-05", league: "sunday" });
    expect(mockedCallGemini).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries if every attempt is malformed", async () => {
    mockedCallGemini.mockResolvedValue('{"date": "2026-07-05"');

    await expect(parseReportText("fake-key", "some report text")).rejects.toThrow(/did not return valid JSON after 2 attempts/);
    expect(mockedCallGemini).toHaveBeenCalledTimes(2);
  });

  it("never retries a thrown error (quota/HTTP failures aren't worth burning more of a daily quota on)", async () => {
    mockedCallGemini.mockRejectedValue(new Error("Gemini API request failed (429): quota exceeded"));

    await expect(parseReportText("fake-key", "some report text")).rejects.toThrow(/429/);
    expect(mockedCallGemini).toHaveBeenCalledTimes(1);
  });
});

describe("extractFirstPickAnnotation", () => {
  it("pulls the annotation out and strips it from what gets sent to the model", () => {
    const raw = "First pick: Ari Fox\n\nVadim: 24 people, first half...";
    const { firstPickRaw, threadText } = extractFirstPickAnnotation(raw);
    expect(firstPickRaw).toBe("Ari Fox");
    expect(threadText).not.toContain("First pick");
    expect(threadText).toContain("Vadim: 24 people");
  });

  it("returns null when there's no annotation, text unchanged", () => {
    const raw = "Vadim: 24 people, first half...";
    const { firstPickRaw, threadText } = extractFirstPickAnnotation(raw);
    expect(firstPickRaw).toBeNull();
    expect(threadText).toBe(raw);
  });
});

describe("stripGmailChrome", () => {
  it("strips Inbox/Summarize/sender-date-recipients chrome, keeps the subject line (real pasted example)", () => {
    const raw = [
      "Sunday, june 14",
      "Inbox",
      "Summarize this email",
      "",
      "Vadim Palmer",
      "Sun, Jun 14, 1:22 PM",
      "to Eduard, Muravchik, idolg, kbarona, Mihail, ruscharge, evreychik1, quanmng, avolkin67, Isaac, Jonathan, Boris, nos01, Oleg, bryanfrid, me, matthew.rakov, levinmik, stolyarmarc18, dsherlis, kirill011594, emre.kapuzov94, lazzturkkemran49, Bryan, polarbear1850",
      "",
      "20 people",
      "",
      "Sandrik, Alan, Lesha, Denis, Boris",
    ].join("\n");

    const cleaned = stripGmailChrome(raw);
    expect(cleaned).toContain("Sunday, june 14");
    expect(cleaned).toContain("20 people");
    expect(cleaned).toContain("Sandrik, Alan, Lesha, Denis, Boris");
    expect(cleaned).not.toContain("Inbox");
    expect(cleaned).not.toContain("Summarize this email");
    expect(cleaned).not.toContain("Vadim Palmer");
    expect(cleaned).not.toContain("1:22 PM");
    expect(cleaned).not.toContain("to Eduard");
  });

  it("handles a date line with a weekday prefix and no year", () => {
    const raw = ["Alan Cho", "Sat, Jul 11, 7:45 AM", "to Someone, Else", "", "Report body here."].join("\n");
    expect(stripGmailChrome(raw)).toBe("Report body here.");
  });

  it("handles a date line with a year and no weekday prefix (real variant, e.g. June 28's report)", () => {
    const raw = ["Vadim Palmer", "Jun 28, 2026, 11:46 AM", "to Eduard, Muravchik", "", "Report body here."].join("\n");
    expect(stripGmailChrome(raw)).toBe("Report body here.");
  });

  it("leaves plain report text with no Gmail chrome completely unchanged in substance", () => {
    const raw = "Vadim, 2026-06-27:\n\n18 people\n\nTeam Orange: Isaac, Slava";
    expect(stripGmailChrome(raw)).toBe(raw);
  });

  it("doesn't mistake the subject line itself for a Gmail date line", () => {
    // "Sunday, june 14" starts with "Sun" but isn't followed by a comma
    // immediately after the day abbreviation — must not be stripped.
    const cleaned = stripGmailChrome("Sunday, june 14\nSome report content.");
    expect(cleaned).toContain("Sunday, june 14");
  });
});
