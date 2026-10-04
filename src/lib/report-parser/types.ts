/** manualResolutions value meaning "this flagged name is a brand-new player, not anyone known" — see ReportImportForm's "Add as new player". */
export const NEW_PLAYER_RESOLUTION = "__new_player__";

/**
 * What Gemini extracts, in raw-name form — before identity resolution.
 * Deliberately mirrors GameRecord's shape but with *Raw name strings
 * instead of canonicalIds, since name resolution is our deterministic,
 * tested code's job (identity.ts), never the LLM's — see
 * resolveExtractionToGameRecord() in parse-report.ts.
 */
export interface RawGoalEvent {
  scorerRaw: string;
  assistRaw: string | null;
  team: "home" | "away" | "unknown";
}

export interface RawNotableMention {
  playerRaw: string;
  quote: string;
}

export interface RawExtraction {
  date: string | null;
  league: "saturday" | "sunday" | "unknown";
  homeRosterRaw: string[];
  awayRosterRaw: string[];
  /**
   * "Home"/"away" has no real meaning for a pickup game — these are only
   * ever populated when the report itself names each side (e.g. "Team
   * Orange"/"Team Blue"), same first-group/second-group convention as the
   * rosters. Null when the report doesn't name sides at all — never guessed
   * by the model; a default display label is applied later in code (see
   * resolveExtractionToGameRecord), not here.
   */
  homeTeamLabelRaw: string | null;
  awayTeamLabelRaw: string | null;
  homeScore: number | null;
  awayScore: number | null;
  goals: RawGoalEvent[];
  /** Vadim's own report narrative only — never a reply's stated opinion. Null if not stated. */
  mvpRaw: string | null;
  notableMentions: RawNotableMention[];
  /**
   * Ordered list of picks, in the exact sequence a report explicitly
   * narrates them (excluding the two captains — see prompt.ts rule 10), when
   * the report actually states one. Each entry is a single raw name, or an
   * array of raw names when several were explicitly picked in the same turn.
   * Null when the report doesn't narrate an explicit pick order — the
   * default alternating assumption in resolveExtractionToGameRecord()
   * applies instead (see parse-report.ts).
   */
  pickOrderRaw: (string | string[])[] | null;
  /**
   * Raw names of players handed straight to a side before the snake draft
   * started, to balance a lopsided pool — narrated separately from the rest
   * of the report (e.g. "To balance the teams X was given to home and Y to
   * away, disclude those from the average draft position"). Same treatment
   * as a captain in resolveExtractionToGameRecord(): still on the roster,
   * but never assigned a pick number and never counted toward
   * avgDraftPosition. Empty/null when the report doesn't mention this.
   */
  preDraftBalanceRaw: string[] | null;
}
