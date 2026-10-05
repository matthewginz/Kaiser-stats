import type { NameResolution, PlayerIdentity } from "./types";

/**
 * Report text is the primary key for stats attribution (see kaiser_BUILD_SPEC.md).
 * Vadim disambiguates duplicate first names himself in-report (e.g. "Sasha SI" vs
 * "Sasha Ru"), so an exact match against a known alias is trusted as-is. Anything
 * that isn't an exact match only ever comes back "flagged" — never auto-merged —
 * because short names are especially risky (Leo/Neo, Alan/Alen could be different
 * real people).
 */

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Reports/spreadsheets are matched against this, never the freely-editable
 * displayName directly — a user renaming their app display name (Settings)
 * must never orphan their historical stats. rosterName is set once at
 * onboarding and only admin-editable after, so it's the stable anchor;
 * displayName is the fallback only for players who've never onboarded (no
 * rosterName set yet).
 */
function primaryMatchName(player: PlayerIdentity): string {
  return player.rosterName?.trim() || player.displayName;
}

const SHORT_NAME_MAX_LENGTH = 5;
const FUZZY_MATCH_MAX_DISTANCE = 1;

export function resolvePlayerName(
  raw: string,
  knownPlayers: PlayerIdentity[],
): NameResolution {
  const rawNorm = normalize(raw);

  for (const player of knownPlayers) {
    const allNames = [primaryMatchName(player), ...player.aliases];
    if (allNames.some((n) => normalize(n) === rawNorm)) {
      return { raw, status: "exact", canonicalId: player.canonicalId, candidates: [] };
    }
  }

  const candidates: NameResolution["candidates"] = [];
  for (const player of knownPlayers) {
    const allNames = [primaryMatchName(player), ...player.aliases];
    let best = Infinity;
    for (const n of allNames) {
      const d = levenshtein(rawNorm, normalize(n));
      if (d < best) best = d;
    }
    // Short names get a tighter (still non-zero) tolerance: a 1-character edit
    // on a 4-5 letter name is exactly the Leo/Neo, Alan/Alen failure mode, so it
    // still surfaces as a flagged candidate for a human to confirm, not a match.
    const maxDistance = rawNorm.length <= SHORT_NAME_MAX_LENGTH
      ? FUZZY_MATCH_MAX_DISTANCE
      : FUZZY_MATCH_MAX_DISTANCE + 1;
    if (best <= maxDistance) {
      candidates.push({ canonicalId: player.canonicalId, displayName: player.displayName, distance: best });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);

  if (candidates.length > 0) {
    return { raw, status: "flagged", canonicalId: null, candidates };
  }
  return { raw, status: "unresolved", canonicalId: null, candidates: [] };
}

/**
 * Whether a raw name is safe to turn into a brand-new public player (and a
 * public /players/<slug> URL). A real report once produced "<name> 15 year
 * old he replaced <name> in the last minute…" — an aside the LLM kept as part
 * of the name, which went live with a minor's age in the URL. Checks the same
 * shape the slug below produces (ASCII letters split on anything else), so a
 * note can't slip through as one "word" like "Ari(fifteen-year-old-sub)":
 * at most 3 letter-only parts joined by spaces or hyphens, 30 chars max.
 * Anything else goes to a human. Only gates NEW identities — existing players
 * resolve before this is ever checked.
 */
export function isPlausiblePlayerName(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed.length <= 30 &&
    /^[a-z][a-z'.]*(?:[\s-]+[a-z][a-z'.]*){0,2}$/i.test(trimmed) &&
    // Spelled-out ages/numbers ("Ari fifteen", "Bex teen yo") are letters-only too.
    !/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|twenty|thirty|forty|fifty|years?|yrs?|old|yo|aged?|teen)\b/i.test(trimmed)
  );
}

/**
 * A genuinely novel name (resolvePlayerName returned "unresolved" — zero
 * fuzzy candidates against the known list) carries no misattribution risk:
 * there's nothing similar it could be silently confused with. Unlike a
 * "flagged" name, it doesn't need a human decision before its stats can be
 * counted — it needs a stable identity to count them under, which this
 * creates. The canonicalId is deterministic (slug of the raw name, prefixed
 * "auto-") so every future row using the exact same raw text resolves to the
 * same provisional player consistently.
 *
 * This does NOT resolve a "flagged" name — a name close to an existing,
 * different one still requires a human to confirm merge-or-not, since
 * guessing wrong there means misattributing a real person's stats to
 * someone else.
 */
export function createProvisionalIdentity(rawName: string): PlayerIdentity {
  const trimmed = rawName.trim();
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return {
    canonicalId: `auto-${slug}`,
    displayName: trimmed,
    aliases: [],
    knownEmails: [],
    leagues: [],
    status: "provisional",
  };
}

/**
 * A verified login email with no match to any known player's knownEmails —
 * same "never block, auto-provision, flag for a human later" philosophy as
 * createProvisionalIdentity(), just keyed by email instead of a report name
 * (see src/lib/auth/actions.ts's linkPlayerAfterLogin()). displayName defaults to the email
 * itself so it's recognizable in the existing "auto-tracked new players"
 * admin surface until a human renames it.
 */
export function createProvisionalIdentityFromEmail(email: string): PlayerIdentity {
  const normalized = email.trim().toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    canonicalId: `auto-${slug}`,
    displayName: normalized,
    aliases: [],
    knownEmails: [normalized],
    leagues: [],
    status: "provisional",
  };
}

/**
 * `status === "provisional"` alone is NOT enough to detect "junk that should
 * never appear in a picker" — it's shared by two very different cases:
 * - createProvisionalIdentity (above): a genuinely new TEAMMATE, seen for the
 *   first time in a report/pasted roster. A real person who's simply new —
 *   never exclude them just because nobody's assigned a roster name yet.
 * - createProvisionalIdentityFromEmail (above): an unresolved LOGIN STUB,
 *   whose displayName is literally the raw email (e.g.
 *   "mikeginzburg@yahoo.com") — this is the actual junk that must never
 *   surface in a picker.
 * The two are only reliably told apart by `knownEmails`: a roster-provisional
 * player always has `knownEmails: []` (createProvisionalIdentity never sets
 * one), while a login stub always has exactly one (the login email) and, by
 * definition of still being unresolved, no rosterName yet either. Once an
 * admin manually assigns a login stub a real roster name (Settings >
 * Members), it's resolved and this returns false for it too.
 */
export function isUnresolvedLoginStub(player: {
  status: string;
  knownEmails: string[];
  rosterName?: string | null;
}): boolean {
  return player.status === "provisional" && player.knownEmails.length > 0 && !player.rosterName?.trim();
}

/** Case-insensitive match against every known player's knownEmails. */
export function findPlayerByEmail(players: PlayerIdentity[], email: string): PlayerIdentity | null {
  const normalized = email.trim().toLowerCase();
  return players.find((p) => p.knownEmails.some((e) => e.toLowerCase() === normalized)) ?? null;
}

/**
 * The name to show wherever recognizing a real person by their game-report
 * name matters more than their personal app-UI preference — today, only the
 * live snake draft (see draft/page.tsx and draft-actions.ts's
 * getLiveDraftState). Falls back to displayName for anyone who hasn't set a
 * roster name yet (never logged in, or onboarded before this field existed).
 */
export function rosterDisplayName(player: { displayName: string; rosterName?: string | null }): string {
  return player.rosterName?.trim() || player.displayName;
}

export interface OnboardingRosterCheckPlayer extends PlayerIdentity {
  authUserId: string | null;
}

export type OnboardingRosterNameCheck =
  | { outcome: "proceed" }
  | { outcome: "merge"; targetCanonicalId: string }
  | { outcome: "error"; error: string };

/**
 * Most of this league's members already exist in `players` from years of
 * spreadsheet backfills — but those historical rows were never given an
 * email, so a returning player's first real login fails findPlayerByEmail
 * and auto-provisions a brand-new, empty "auto-<email>" stub instead (see
 * createProvisionalIdentity's deterministic id prefix above). Onboarding's
 * roster-name step is the only remaining chance to reunite that stub with
 * the person's real historical identity — this decides what a just-typed
 * roster name means against everyone else already known, using the exact
 * same exact/flagged/unresolved split resolvePlayerName always uses (never
 * auto-merge a fuzzy match — same "never guess" rule as the rest of this
 * file), with a merge-vs-conflict branch added for the exact-match case. The
 * actual merge (delete the stub, reassign the historical row) is an I/O
 * concern that lives in completeOnboarding() (src/lib/auth/actions.ts), not
 * here — this function only decides, it never touches the database.
 */
export function resolveOnboardingRosterName(
  ownCanonicalId: string,
  ownStatus: PlayerIdentity["status"],
  trimmedRosterName: string,
  others: OnboardingRosterCheckPlayer[],
): OnboardingRosterNameCheck {
  const resolution = resolvePlayerName(trimmedRosterName, others);

  if (resolution.status === "flagged") {
    const closest = resolution.candidates[0]?.displayName;
    return {
      outcome: "error",
      error: closest
        ? `That's close to an existing player, "${closest}" — double-check the spelling, or ask an admin if you're new.`
        : "That name is close to an existing player's — double-check the spelling, or ask an admin if you're new.",
    };
  }

  if (resolution.status !== "exact") return { outcome: "proceed" };

  const target = others.find((p) => p.canonicalId === resolution.canonicalId);
  if (!target) return { outcome: "proceed" };

  // A merge only ever runs FROM a just-created login stub INTO a real
  // historical identity, never the reverse — the deterministic "auto-"
  // prefix + "provisional" status is exactly and only how
  // createProvisionalIdentityFromEmail marks such a stub. Anything else
  // (the target already claimed by a different login, or the caller's own
  // row already being a real identity) is a genuine conflict, not a merge.
  const ownIsLoginStub = ownCanonicalId.startsWith("auto-") && ownStatus === "provisional";
  if (target.authUserId || !ownIsLoginStub) {
    return {
      outcome: "error",
      error: "That roster name is already linked to another account — ask an admin to sort this out.",
    };
  }

  return { outcome: "merge", targetCanonicalId: target.canonicalId };
}
