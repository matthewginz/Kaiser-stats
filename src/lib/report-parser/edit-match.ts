export interface MatchEditInput {
  homeScoreRaw: string;
  awayScoreRaw: string;
  mvpCanonicalId: string;
  description: string;
}

export interface MatchEdit {
  homeScore: number | null;
  awayScore: number | null;
  mvpCanonicalId: string | null;
  description: string | null;
}

function parseScore(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,2}$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/**
 * Validates the admin's edit-match form. Scores stay both-null-or-both-set
 * (see GameRecord.homeScore) — both blank turns the game into a "no report"
 * game, one blank is an error.
 */
export function validateMatchEdit(input: MatchEditInput): { ok: true; edit: MatchEdit } | { ok: false; error: string } {
  const homeScore = parseScore(input.homeScoreRaw);
  const awayScore = parseScore(input.awayScoreRaw);
  if (homeScore === undefined || awayScore === undefined) {
    return { ok: false, error: "Scores must be whole numbers (0–99)." };
  }
  if ((homeScore === null) !== (awayScore === null)) {
    return { ok: false, error: "Fill in both scores, or leave both blank for a no-report game." };
  }
  return {
    ok: true,
    edit: {
      homeScore,
      awayScore,
      mvpCanonicalId: input.mvpCanonicalId.trim() || null,
      description: input.description.trim() || null,
    },
  };
}
