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

// ponytail: US-style 10-digit numbers only; widen if international numbers show up.
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

/** Also strips the Gmail header (its "to …" line lists recipients' email usernames) and phone numbers — names stay, every way to contact someone goes. */
export function redactReportText(text: string): string {
  return stripGmailChrome(text)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email removed]")
    .replace(PHONE_PATTERN, "[phone removed]")
    .replace(AGE_PATTERN, "[age removed]");
}

// Gmail's own "copy the thread text" output repeats this exact boilerplate
// once per message: a sender-name line, then a date/time line, then a
// "to <comma-separated recipients>" line — none of it is report content, and
// the recipients are email usernames, so it must never be public. "Inbox" and
// "Summarize this email" are separate stray UI-chrome lines Gmail's copy also
// includes. The date/time line's format varies (confirmed real variants):
// "Sun, Jun 21, 11:14 AM", "Jun 28, 2026, 11:46 AM", and for recent mail
// "1:09 PM (1 hour ago)" / "Sat, Oct 3, 8:51 PM (17 hours ago)" — so the
// weekday, date, year and "(… ago)" suffix are all optional.
const GMAIL_DATE_LINE =
  /^(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s+)?(?:\w+\s+\d{1,2},\s+(?:\d{4},\s+)?)?\d{1,2}:\d{2}\s*(?:AM|PM)(?:\s*\([^)]*\))?$/i;

/** Strips Gmail copy-paste chrome (see GMAIL_DATE_LINE's comment) out of a pasted thread. */
export function stripGmailChrome(rawText: string): string {
  const lines = rawText.split("\n");
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();

    if (/^inbox$/i.test(trimmed) || /^summarize this email$/i.test(trimmed)) continue;

    const nextTrimmed = lines[i + 1]?.trim() ?? "";
    if (trimmed.length > 0 && GMAIL_DATE_LINE.test(nextTrimmed)) {
      i += 1; // also skip the date line
      if (lines[i + 1]?.trim().toLowerCase().startsWith("to ")) i += 1; // and the recipients line, if present
      continue;
    }

    kept.push(lines[i]!);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
