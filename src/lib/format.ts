/**
 * "2026-07-12" -> "SUN JUL 12". Formats in UTC deliberately — new
 * Date(iso) parses a date-only ISO string as UTC midnight, and formatting
 * without timeZone: "UTC" would let the server/browser's local offset shift
 * the displayed date by a day.
 */
export function formatMatchDateLabel(iso: string): string {
  const date = new Date(iso);
  return date
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    .toUpperCase()
    .replace(",", "");
}

/** A chat message's send time in the viewer's own local time, e.g. "3:45 PM" — unlike match dates, this is a live timestamp, not a fixed calendar date, so it deliberately isn't forced to UTC. */
export function formatChatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Report text is the organizer's raw email thread, and it shows on public
 * match pages. Strips what must never be public: email addresses (thread
 * headers like "Vadim (x@yahoo.com), date:") and ages — the organizer
 * routinely notes a newcomer's age, and some are minors ("Ari (15 year
 * old, …)", "Dov is 16 years old"). Applied on read, so it covers every
 * stored game and every future import without rewriting the database.
 */
export function redactReportText(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email removed]")
    .replace(/\b\d{1,2}[\s-]*(?:years?|yrs?)[\s-]*old\b/gi, "[age removed]");
}

/** Null scores mean a "no report" game (see GameRecord.homeScore's doc comment) — a real roster, no score ever emailed. */
export function formatScoreLine(homeScore: number | null, awayScore: number | null): string {
  if (homeScore === null || awayScore === null) return "No report";
  return `${homeScore} – ${awayScore}`;
}

export function formatWDL(wins: number, ties: number, losses: number): string {
  return `${wins}-${ties}-${losses}`;
}

export function formatPlusMinus(plusMinus: number): string {
  return plusMinus > 0 ? `+${plusMinus}` : `${plusMinus}`;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

const MULTI_GOAL_NICKNAME_BY_COUNT: Record<number, string> = {
  2: "Brace",
  3: "Hat-trick",
  4: "Poker",
  5: "Glut",
  6: "Double Hat-trick",
};

/** A fun soccer term for a multi-goal game, or null if there isn't a named one for this count. */
export function getMultiGoalNickname(count: number): string | null {
  return MULTI_GOAL_NICKNAME_BY_COUNT[count] ?? null;
}
