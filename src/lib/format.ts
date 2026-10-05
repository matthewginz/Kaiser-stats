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
// ponytail: pattern list, not NLP — "a teenager"/"in 10th grade" still pass; widen here if they show up.
const AGE_NUMBER = String.raw`(?:\d{1,2}|(?:twenty|thirty|forty|fifty|sixty)(?:[\s-]?(?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)`;
const AGE_PATTERN = new RegExp(
  [
    String.raw`\b${AGE_NUMBER}[\s-]*(?:years?|yrs?)[\s-]*(?:old|of\s+age)\b`, // 15 year old, fifteen-year-old, 15 yrs of age
    String.raw`\b${AGE_NUMBER}\s*(?:y\/o|y\.o\.?|yo)(?![a-z])`, // 15yo, 15 y/o, 15 y.o.
    String.raw`\bage[ds]?\s*:?\s*${AGE_NUMBER}\b`, // aged 15, age: 15
  ].join("|"),
  "gi",
);

export function redactReportText(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email removed]")
    .replace(AGE_PATTERN, "[age removed]");
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
