import { computeMvp } from "../stats-engine/goal-summary";
import { createProvisionalIdentity, isPlausiblePlayerName, resolvePlayerName } from "../stats-engine/identity";
import type { GameRecord, GoalEvent, NameResolution, NotableMention, PlayerIdentity, RosterSpot } from "../stats-engine/types";
import { callGemini } from "./gemini-client";
import { buildExtractionPrompt } from "./prompt";
import { NEW_PLAYER_RESOLUTION, type RawExtraction } from "./types";

const FIRST_PICK_LINE = /^\s*first pick\s*:\s*(.+?)\s*$/im;

/**
 * Pulls an optional "First pick: <name>" annotation out of a report text
 * file before it's sent to Gemini — this is a human-supplied fact typed
 * into the local file, never something the model reads or infers, so it's
 * parsed here with a plain regex and stripped out of what the model sees.
 */
export function extractFirstPickAnnotation(rawFileText: string): { firstPickRaw: string | null; threadText: string } {
  const match = rawFileText.match(FIRST_PICK_LINE);
  if (!match) return { firstPickRaw: null, threadText: rawFileText };
  return {
    firstPickRaw: match[1]?.trim() ?? null,
    threadText: rawFileText.replace(FIRST_PICK_LINE, "").trim(),
  };
}

// Gmail's own "copy the thread text" output repeats this exact boilerplate
// once per message: a sender-name line, then a date/time line, then a
// "to <comma-separated recipients>" line — none of it is report content,
// and leaving it in wastes the model's attention (and once already caused a
// real parse to trip up trying to treat "to Eduard, Muravchik, ..." as game
// content). "Inbox" and "Summarize this email" are separate stray UI-chrome
// lines Gmail's copy also includes. The date/time line's exact format
// varies (confirmed two real variants): "Sun, Jun 21, 11:14 AM" (weekday,
// no year) and "Jun 28, 2026, 11:46 AM" (year, no weekday) — both the
// weekday prefix and the year are optional here to cover either.
const GMAIL_DATE_LINE =
  /^((Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s+)?\w+\s+\d{1,2},\s+(\d{4},\s+)?\d{1,2}:\d{2}\s*(AM|PM)$/i;

/**
 * Strips Gmail copy-paste chrome (see GMAIL_DATE_LINE's comment) out of a
 * pasted thread before it reaches the model — deliberately applied inside
 * parseReportText itself (not left to each caller, unlike
 * extractFirstPickAnnotation's human-supplied annotation) since this is
 * pure noise removal that's always safe, regardless of source.
 */
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

// A real response has been observed to come back HTTP 200, finishReason
// "STOP" (Gemini considers itself done), but with the JSON body truncated
// anyway — confirmed via usageMetadata showing thousands of tokens spent on
// invisible "thinking" before a short visible completion, nowhere near the
// maxOutputTokens cap. This is an intermittent model-side quirk, not a
// truncation we can fix by raising the cap further, so one retry (a fresh
// API call, not a re-parse of the same bad text) is the practical fix.
const MAX_PARSE_ATTEMPTS = 2;

export async function parseReportText(apiKey: string, threadText: string): Promise<RawExtraction> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const prompt = buildExtractionPrompt(stripGmailChrome(threadText), todayIso);

  let lastMalformedResponse = "";
  for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS; attempt++) {
    // Network/HTTP errors (quota exhaustion, high-demand 503s) propagate
    // immediately, never retried here — retrying those just burns more of a
    // daily quota that may already be exhausted, for no chance of success.
    const responseText = await callGemini(apiKey, prompt);
    try {
      return JSON.parse(responseText) as RawExtraction;
    } catch {
      lastMalformedResponse = responseText;
    }
  }
  throw new Error(
    `Gemini did not return valid JSON after ${MAX_PARSE_ATTEMPTS} attempts: ${lastMalformedResponse}`,
  );
}

export interface ResolvedReport {
  gameRecord: GameRecord;
  /** New identities auto-created for names with no fuzzy match to anything (see identity.ts). */
  provisionedPlayers: PlayerIdentity[];
  /** Names close to a DIFFERENT existing player — excluded from the GameRecord, need a human decision. */
  flaggedNames: NameResolution[];
  /** True if goal scorer counts per team don't sum to the stated score — per kaiser_BUILD_SPEC.md, don't trust this parse's goals without review if so. */
  goalSumMismatch: boolean;
  /**
   * Set only if a "First pick" annotation was supplied but didn't match the
   * first-listed player of either roster — a real inconsistency worth a
   * human's attention, never silently ignored. Pick numbers stay null for
   * this game in that case (the default alternating assumption is skipped
   * too, since something about the annotation is already wrong).
   */
  firstPickWarning: string | null;
  /**
   * Set only if extraction.pickOrderRaw named someone who couldn't be
   * resolved to either roster — the rest of the narrated order is still
   * applied, but this game's pick numbers may be incomplete.
   */
  pickOrderWarning: string | null;
  /**
   * Whether the roster listing above was actually treated as real draft
   * order for pick-number purposes — either the human's explicit answer
   * (rosterOrderIsDraftOrderOverride) or, unanswered, the team-label
   * heuristic's own guess. ReportImportForm always shows this as a yes/no
   * question rather than silently trusting the guess either way.
   */
  rosterOrderIsDraftOrder: boolean;
}

/**
 * Converts a RawExtraction (LLM output, raw name strings) into a GameRecord
 * (canonicalIds only) — this is where identity resolution actually happens,
 * using the exact same deterministic, tested logic the spreadsheet-backfill
 * path uses (resolvePlayerName / createProvisionalIdentity), never the LLM's
 * own judgment about who a name "really" is.
 *
 * Pick numbers, in priority order. In every case, roster[0] of each side is
 * that team's captain (see prompt.ts rule 10) — captains choose, they
 * aren't chosen, so they always keep pickNumber: null and are never part of
 * the numbered sequence at all; numbering starts at 1 with the first player
 * actually drafted (confirmed 2026-07-16 — an earlier version of this
 * reserved pick 1/2 for the two captains, which inflated every real pick's
 * number and skewed avgDraftPosition for anyone who frequently captains).
 * 1. Default — only when the report's roster listing is actually confirmed
 *    draft order (`rosterOrderIsDraftOrder`: neither side's team label was
 *    explicitly stated — see rule 5/10 in prompt.ts). A report that instead
 *    names both sides up front (e.g. "Team Orange:"/"Team Blue:") is
 *    confirmed (2026-07-17, the real June 27 game) to just be listing who
 *    played, NOT draft order — every pick number stays null for that game
 *    unless step 3 below applies. When it does apply: the team listed
 *    first (home) is assumed to have picked first, alternating strict
 *    snake order by each roster's own listed order (excluding roster[0]) —
 *    a confirmed league convention, not a guess. Overrides a
 *    `docs/data-contract.md` note from before this convention was
 *    confirmed with the league organizer.
 * 2. `firstPickRaw` (optional, human-supplied — see docs/report-parsing.md):
 *    the name of whoever actually picked first, when a specific game
 *    contradicts the default. Must match one roster's first-listed player,
 *    else `firstPickWarning` is set and pick numbers are left null rather
 *    than guessed. Only meaningful when step 1 would otherwise apply.
 * 3. `extraction.pickOrderRaw` (optional, model-extracted — see prompt.ts
 *    rule 10): when a report narrates the real pick-by-pick order in prose,
 *    that ground truth overrides the default for every pick (captains are
 *    never in this list either — see prompt.ts rule 10) — applies
 *    regardless of rosterOrderIsDraftOrder, since narrated prose is a real
 *    stated fact, not an assumption about listing order.
 */
export function resolveExtractionToGameRecord(
  extraction: RawExtraction,
  knownPlayers: PlayerIdentity[],
  meta: { gameId: string; source: string; fallbackDate: string; fallbackLeague: "saturday" | "sunday" | "unknown" },
  firstPickRaw?: string | null,
  // A human's answer to a flagged name from a previous preview of this same
  // text — see ReportImportForm's "Accept"/"pick a player" controls. Keyed by
  // raw.trim().toLowerCase() so it matches regardless of the exact casing
  // Gemini re-extracts on a repeat parse. Checked before resolvePlayerName so
  // a confirmed name never re-flags, and short-circuits straight to a real
  // canonicalId instead of the usual candidates-only flag.
  manualResolutions?: Record<string, string>,
  // A human's explicit yes/no answer (see ReportImportForm's roster-order
  // question) to "is the roster listing above real draft order?" — always
  // shown and always decides the outcome once answered, overriding the
  // team-label heuristic below entirely (a report can name "Team Orange"/
  // "Team Blue" and STILL have listed players in real draft order — the
  // label alone was never reliable enough to fully trust). Null/undefined
  // means "not answered yet," so the heuristic is used as the shown default.
  rosterOrderIsDraftOrderOverride?: boolean | null,
): ResolvedReport {
  const flaggedNames: NameResolution[] = [];
  const provisionedByRaw = new Map<string, PlayerIdentity>();
  const seenFlagged = new Set<string>();

  const knownIds = new Set(knownPlayers.map((p) => p.canonicalId));

  function provision(raw: string): string {
    const key = raw.trim().toLowerCase();
    let provisional = provisionedByRaw.get(key);
    if (!provisional) {
      provisional = createProvisionalIdentity(raw);
      // Never reuse an existing player's id (e.g. a retired, merged-away
      // `auto-leonel`) — the save upserts provisioned players, so a reused id
      // would overwrite that row instead of creating a new person.
      const baseId = provisional.canonicalId;
      for (let n = 2; knownIds.has(provisional.canonicalId); n++) {
        provisional = { ...provisional, canonicalId: `${baseId}-${n}` };
      }
      provisionedByRaw.set(key, provisional);
    }
    return provisional.canonicalId;
  }

  function flag(resolution: NameResolution): null {
    const key = resolution.raw.toLowerCase();
    if (!seenFlagged.has(key)) {
      seenFlagged.add(key);
      flaggedNames.push(resolution);
    }
    return null;
  }

  // A string that doesn't look like a name (see isPlausiblePlayerName) never
  // becomes a new public player — not even on an admin's "Add as new player"
  // — it's flagged with no candidates so a human maps it to a real player.
  function provisionOrFlag(raw: string): string | null {
    if (isPlausiblePlayerName(raw)) return provision(raw);
    return flag({ raw, status: "flagged", canonicalId: null, candidates: [] });
  }

  function resolve(raw: string): string | null {
    const manual = manualResolutions?.[raw.trim().toLowerCase()];
    if (manual === NEW_PLAYER_RESOLUTION) return provisionOrFlag(raw);
    if (manual) return manual;

    const pool = [...knownPlayers, ...provisionedByRaw.values()];
    const resolution = resolvePlayerName(raw, pool);

    if (resolution.status === "exact" && resolution.canonicalId) {
      return resolution.canonicalId;
    }
    if (resolution.status === "flagged") return flag(resolution);
    // "unresolved" — no fuzzy match to anything, no misattribution risk.
    return provisionOrFlag(raw);
  }

  // Keeps a `null` placeholder for a flagged/unresolved name instead of just
  // dropping it — critical for the pick-number math below, which needs each
  // resolved spot's ORIGINAL position in the report's listing (gaps and
  // all), not its position after excluded names are filtered out. An
  // earlier version filtered before numbering, which silently shifted every
  // subsequent teammate's pick number down by one per exclusion (confirmed
  // 2026-07-17 on two real games where a flagged name wasn't the last one
  // listed on its side).
  function resolveRosterSlots(namesRaw: string[]): (RosterSpot | null)[] {
    return namesRaw.map((raw) => {
      const canonicalId = resolve(raw);
      return canonicalId ? { canonicalId, pickNumber: null } : null;
    });
  }

  const homeRosterSlots = resolveRosterSlots(extraction.homeRosterRaw ?? []);
  const awayRosterSlots = resolveRosterSlots(extraction.awayRosterRaw ?? []);
  const homeRoster = homeRosterSlots.filter((spot): spot is RosterSpot => spot !== null);
  const awayRoster = awayRosterSlots.filter((spot): spot is RosterSpot => spot !== null);

  // Players handed straight to a side pre-draft (see prompt.ts rule 13) —
  // real roster spots, but they never get a pick number and are removed from
  // the sequence entirely below, same as a captain (never gap-preserved like
  // a flagged name, since they never actually took a real draft turn at all).
  const preDraftBalanceIds = new Set(
    (extraction.preDraftBalanceRaw ?? []).map((raw) => resolve(raw)).filter((id): id is string => id !== null),
  );

  let firstPickWarning: string | null = null;
  let homePicksFirst = true; // default: the team listed first (home) picked first — see resolveExtractionToGameRecord's doc comment
  if (firstPickRaw) {
    const firstPickCanonicalId = resolve(firstPickRaw);
    const homeFirst = homeRoster[0]?.canonicalId;
    const awayFirst = awayRoster[0]?.canonicalId;

    if (firstPickCanonicalId && firstPickCanonicalId === homeFirst) {
      homePicksFirst = true;
    } else if (firstPickCanonicalId && firstPickCanonicalId === awayFirst) {
      homePicksFirst = false;
    } else {
      firstPickWarning = `"First pick: ${firstPickRaw}" didn't match the first-listed player of either roster — pick numbers left null for this game rather than guessed.`;
    }
  }

  // Shown default only: a report that explicitly names both sides (e.g.
  // "Team Orange:"/"Team Blue:") USUALLY is just listing who's playing, not
  // draft order — confirmed 2026-07-17, the "N people" blank-line-separated
  // convention is the one whose listed order is normally real draft order.
  // "Usually" because this heuristic alone isn't trustworthy enough on its
  // own (a team-labeled report can still happen to list players in real
  // draft order) — rosterOrderIsDraftOrderOverride is the human's actual
  // answer to the question ReportImportForm always asks, and wins outright
  // once given.
  const rosterOrderIsDraftOrder =
    rosterOrderIsDraftOrderOverride ?? (!extraction.homeTeamLabelRaw && !extraction.awayTeamLabelRaw);

  let pickOrderWarning: string | null = null;
  if (!firstPickWarning && rosterOrderIsDraftOrder) {
    const firstSlots = homePicksFirst ? homeRosterSlots : awayRosterSlots;
    const secondSlots = homePicksFirst ? awayRosterSlots : homeRosterSlots;
    // roster[0] of each side is that team's captain — never actually
    // picked, so it's skipped here and keeps its default pickNumber: null
    // rather than reserving 1/2 for it. Iterating the SLOTS array (not the
    // filtered roster) so a gap left by an excluded name doesn't shift
    // every later teammate's pick number down — see resolveRosterSlots. A
    // pre-draft-balance slot is filtered out of this array entirely first
    // (not just skipped in place) — unlike a flagged name's gap, it never
    // occupied a real draft turn, so it must not consume a numbered slot
    // that shifts everyone listed after it.
    const notBalance = (spot: RosterSpot | null) => spot === null || !preDraftBalanceIds.has(spot.canonicalId);
    firstSlots.slice(1).filter(notBalance).forEach((spot, i) => {
      if (spot) spot.pickNumber = 2 * i + 1;
    });
    secondSlots.slice(1).filter(notBalance).forEach((spot, i) => {
      if (spot) spot.pickNumber = 2 * i + 2;
    });
  }

  // Independent of rosterOrderIsDraftOrder — a narrated pick order is real,
  // explicit prose naming the actual sequence, not an assumption about
  // roster listing order, so it applies (and overrides any default numbers
  // above) regardless of which listing format this report used.
  if (extraction.pickOrderRaw && extraction.pickOrderRaw.length > 0) {
    const allSpots = [...homeRoster, ...awayRoster];
    let nextPick = 1; // captains are never numbered at all, so the narrated sequence starts at 1
    for (const turn of extraction.pickOrderRaw) {
      const namesRaw = Array.isArray(turn) ? turn : [turn];
      for (const raw of namesRaw) {
        const canonicalId = resolve(raw);
        const spot = canonicalId ? allSpots.find((s) => s.canonicalId === canonicalId) : undefined;
        // A pre-draft-balance player should never legitimately appear in a
        // narrated pick order (see rule 13) — guarded here too rather than
        // trusting that never happens, same "never a real pick number"
        // treatment as the default-numbering path above.
        if (spot && canonicalId && !preDraftBalanceIds.has(canonicalId)) {
          spot.pickNumber = nextPick;
        } else if (!spot && !pickOrderWarning) {
          pickOrderWarning = `"${raw}" from the narrated pick order wasn't found on either roster — some pick numbers may be incomplete for this game.`;
        }
        nextPick += 1;
      }
    }
  }

  const goals: GoalEvent[] = [];
  for (const g of extraction.goals ?? []) {
    const scorerCanonicalId = resolve(g.scorerRaw);
    if (!scorerCanonicalId) continue; // flagged/ambiguous scorer — don't attribute the goal at all
    const assistCanonicalId = g.assistRaw ? resolve(g.assistRaw) : null;
    goals.push({
      scorerCanonicalId,
      assistCanonicalId,
      team: g.team === "home" || g.team === "away" ? g.team : "home",
    });
  }

  const narrativeMvpCanonicalId = extraction.mvpRaw ? resolve(extraction.mvpRaw) : null;

  const notableMentions: NotableMention[] = [];
  for (const m of extraction.notableMentions ?? []) {
    const canonicalId = resolve(m.playerRaw);
    if (canonicalId) notableMentions.push({ canonicalId, quote: m.quote });
  }

  const homeScore = extraction.homeScore ?? 0;
  const awayScore = extraction.awayScore ?? 0;
  const mvpCanonicalId = computeMvp(goals, homeScore, awayScore, narrativeMvpCanonicalId);
  const homeGoalCount = goals.filter((g) => g.team === "home").length;
  const awayGoalCount = goals.filter((g) => g.team === "away").length;
  const goalSumMismatch =
    extraction.homeScore !== null &&
    extraction.awayScore !== null &&
    (homeGoalCount !== homeScore || awayGoalCount !== awayScore);

  const gameRecord: GameRecord = {
    gameId: meta.gameId,
    date: extraction.date ?? meta.fallbackDate,
    league: extraction.league === "saturday" || extraction.league === "sunday" ? extraction.league : meta.fallbackLeague,
    homeRoster,
    awayRoster,
    // Only ever populated by the model when the report itself names sides
    // (see RawExtraction's doc comment) — otherwise this plain default
    // applies. Unlike a player identity, a wrong guess here can't
    // misattribute anyone's stats, it's just a label.
    homeTeamLabel: extraction.homeTeamLabelRaw?.trim() || "Orange",
    awayTeamLabel: extraction.awayTeamLabelRaw?.trim() || "Blue",
    homeScore,
    awayScore,
    goals,
    mvpCanonicalId,
    notableMentions,
    source: meta.source,
  };

  return {
    gameRecord,
    provisionedPlayers: Array.from(provisionedByRaw.values()),
    flaggedNames,
    goalSumMismatch,
    firstPickWarning,
    pickOrderWarning,
    rosterOrderIsDraftOrder,
  };
}
