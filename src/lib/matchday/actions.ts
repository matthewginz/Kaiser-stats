"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/session";
import { createProvisionalIdentity, isPlausiblePlayerName, resolvePlayerName } from "@/lib/stats-engine/identity";
import type { PlayerIdentity } from "@/lib/stats-engine/types";
import { createServiceRoleClient } from "@/lib/supabase/client";
import { LEAGUE_CAPACITY_BY_LEAGUE } from "./constants";
import { deriveLeagueFromDate, getRegistrationStatus, parseEasternDateTimeToUtc } from "./registration-window";
import type { MatchdayActionResult, ScheduledLeague } from "./types";

const UNIQUE_VIOLATION = "23505";

// Zero-width space, zero-width non-joiner, zero-width joiner, and the
// BOM/zero-width-no-break-space — Google Docs/Gmail copy-paste sometimes
// leaves one at the start of a pasted line (confirmed on a real pasted
// roster). Filtered by code point rather than a `[...]` character class:
// a class containing the zero-width joiner reads as a misleading/joined
// character sequence to static analysis, since ZWJ's entire purpose is
// combining adjacent code points into one glyph.
const ZERO_WIDTH_CODE_POINTS = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);

function stripZeroWidthChars(text: string): string {
  return Array.from(text)
    .filter((ch) => !ZERO_WIDTH_CODE_POINTS.has(ch.codePointAt(0) ?? -1))
    .join("");
}

function revalidateGamePaths(gameId: string) {
  revalidatePath("/matchday");
  revalidatePath(`/matchday/${gameId}`);
  revalidatePath(`/matchday/${gameId}/edit`);
}

/**
 * Every action here independently re-checks admin-ness. Server Actions
 * compile to a callable endpoint reachable regardless of which page's JSX
 * references them — this must never be assumed safe just because only the
 * requireAdmin()-gated edit page currently links to it (see session.ts).
 */
async function requireAdminResult(): Promise<{ canonicalId: string } | MatchdayActionResult> {
  const admin = await getCurrentUser();
  if (!admin?.isAdmin) return { ok: false, error: "Admin access required." };
  return admin;
}

export async function checkInExistingPlayer(
  gameId: string,
  canonicalId: string,
): Promise<MatchdayActionResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const client = createServiceRoleClient();

  const { data: existing } = await client
    .from("game_checkins")
    .select("id")
    .eq("game_id", gameId)
    .eq("canonical_id", canonicalId)
    .is("removed_at", null)
    .maybeSingle();

  if (existing) return { ok: false, error: "Already checked in." };

  const { error } = await client.from("game_checkins").insert({
    game_id: gameId,
    canonical_id: canonicalId,
    checked_in_by: admin.canonicalId,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, error: "Already checked in." };
    return { ok: false, error: "Could not check in that player." };
  }

  revalidateGamePaths(gameId);
  return { ok: true };
}

/**
 * Self-service check-in — any logged-in player checking THEMSELVES in, not
 * an admin action. Re-derives who's asking from their own auth session
 * (never a client-passed canonicalId) and independently re-verifies
 * registration is actually open server-side (never trusts the button
 * merely being rendered, in case of a stale page).
 */
export async function checkInSelf(gameId: string): Promise<MatchdayActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const client = createServiceRoleClient();

  const { data: game } = await client
    .from("scheduled_games")
    .select("date, league, cancelled_at, registration_cutoff_override")
    .eq("game_id", gameId)
    .maybeSingle();
  if (!game) return { ok: false, error: "Game not found." };
  if (game.cancelled_at) return { ok: false, error: "This game has been cancelled." };

  const league = game.league as ScheduledLeague;
  const cutoffOverrideUtc = game.registration_cutoff_override ? new Date(game.registration_cutoff_override) : null;
  const status = getRegistrationStatus(new Date(), game.date, league, cutoffOverrideUtc);
  if (status === "not-open") return { ok: false, error: "Registration hasn't opened yet for this game." };
  if (status === "closed") return { ok: false, error: "Registration has closed for this game." };

  // Re-checked server-side even though the UI already hides the check-in
  // button once a game reads as "filled" (see computeMatchdayStatusTier) —
  // that's a display-only snapshot, not an enforced limit, so a stale page
  // or a race between two people checking in at once must still be caught
  // here rather than silently over-filling the roster.
  const { count: checkedInCount } = await client
    .from("game_checkins")
    .select("id", { count: "exact", head: true })
    .eq("game_id", gameId)
    .is("removed_at", null);
  if ((checkedInCount ?? 0) >= LEAGUE_CAPACITY_BY_LEAGUE[league]) {
    return { ok: false, error: "This game is already full." };
  }

  const { error } = await client.from("game_checkins").insert({
    game_id: gameId,
    canonical_id: user.canonicalId,
    checked_in_by: user.canonicalId,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, error: "Already checked in." };
    return { ok: false, error: "Could not check you in." };
  }

  revalidateGamePaths(gameId);
  return { ok: true };
}

/** Self-service cancel — a player removing their own check-in, same re-derivation as checkInSelf(). */
export async function cancelSelfCheckIn(gameId: string): Promise<MatchdayActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const client = createServiceRoleClient();

  const { data, error } = await client
    .from("game_checkins")
    .update({ removed_at: new Date().toISOString(), removed_by: user.canonicalId })
    .eq("game_id", gameId)
    .eq("canonical_id", user.canonicalId)
    .is("removed_at", null)
    .select("id");

  if (error) return { ok: false, error: "Could not cancel your check-in." };
  if (!data || data.length === 0) return { ok: false, error: "Not currently checked in." };

  revalidateGamePaths(gameId);
  return { ok: true };
}

export async function checkInNewPlayer(gameId: string, rawName: string): Promise<MatchdayActionResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const trimmed = rawName.trim();
  if (!trimmed) return { ok: false, error: "Name can't be empty." };
  if (!isPlausiblePlayerName(trimmed)) {
    return { ok: false, error: "Use just the player's name — up to 3 words, letters only, no notes." };
  }

  const client = createServiceRoleClient();

  const { data: game } = await client
    .from("scheduled_games")
    .select("league")
    .eq("game_id", gameId)
    .maybeSingle();
  if (!game) return { ok: false, error: "Game not found." };

  const provisional = createProvisionalIdentity(trimmed);

  const { data: existingPlayer } = await client
    .from("players")
    .select("canonical_id")
    .eq("canonical_id", provisional.canonicalId)
    .maybeSingle();

  if (!existingPlayer) {
    const { error: insertPlayerError } = await client.from("players").insert({
      canonical_id: provisional.canonicalId,
      display_name: provisional.displayName,
      aliases: provisional.aliases,
      known_emails: provisional.knownEmails,
      leagues: [game.league],
      status: provisional.status,
    });
    if (insertPlayerError) return { ok: false, error: "Could not create that player." };
  }

  return checkInExistingPlayer(gameId, provisional.canonicalId);
}

/**
 * Plain-<form>-compatible wrapper: form `action` props must return void, but
 * removeCheckIn() returns a result for callers that need to show an error
 * (e.g. a future client-driven remove button). The edit page's simple
 * per-row remove form has nowhere to show that result anyway, so it just
 * discards it here.
 */
export async function removeCheckInFormAction(gameId: string, canonicalId: string): Promise<void> {
  await removeCheckIn(gameId, canonicalId);
}

export async function removeCheckIn(gameId: string, canonicalId: string): Promise<MatchdayActionResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const client = createServiceRoleClient();

  const { data, error } = await client
    .from("game_checkins")
    .update({ removed_at: new Date().toISOString(), removed_by: admin.canonicalId })
    .eq("game_id", gameId)
    .eq("canonical_id", canonicalId)
    .is("removed_at", null)
    .select("id");

  if (error) return { ok: false, error: "Could not remove that check-in." };
  if (!data || data.length === 0) return { ok: false, error: "Not currently checked in." };

  revalidateGamePaths(gameId);
  return { ok: true };
}

/** Bulk version of removeCheckIn — clears every currently-active check-in for this game in one update, for starting the roster over from scratch. */
export async function removeAllCheckIns(gameId: string): Promise<MatchdayActionResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const client = createServiceRoleClient();

  const { error } = await client
    .from("game_checkins")
    .update({ removed_at: new Date().toISOString(), removed_by: admin.canonicalId })
    .eq("game_id", gameId)
    .is("removed_at", null);

  if (error) return { ok: false, error: "Could not remove all check-ins." };

  revalidateGamePaths(gameId);
  return { ok: true };
}

/** Plain-<form>-compatible wrapper, same reasoning as removeCheckInFormAction. */
export async function cancelScheduledGameFormAction(gameId: string): Promise<void> {
  await cancelScheduledGame(gameId);
}

export async function cancelScheduledGame(gameId: string): Promise<MatchdayActionResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const client = createServiceRoleClient();

  const { data, error } = await client
    .from("scheduled_games")
    .update({ cancelled_at: new Date().toISOString(), cancelled_by: admin.canonicalId })
    .eq("game_id", gameId)
    .is("cancelled_at", null)
    .select("game_id");

  if (error) return { ok: false, error: "Could not cancel that game." };
  if (!data || data.length === 0) {
    return { ok: false, error: "Game not found or already cancelled." };
  }

  revalidateGamePaths(gameId);
  return { ok: true };
}

export async function createOneOffGame(input: {
  date: string;
  kickoffLabel: string;
  venue: string;
  cutoffOverrideRaw: string | null;
}): Promise<MatchdayActionResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const date = input.date.trim();
  const kickoffLabel = input.kickoffLabel.trim();
  const venue = input.venue.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Enter a valid date." };
  if (!kickoffLabel) return { ok: false, error: "Kickoff time can't be empty." };
  if (!venue) return { ok: false, error: "Venue can't be empty." };

  // There's only ever been one real league — Saturday/Sunday just names which
  // day a game falls on (see deriveLeagueFromDate's doc comment), so this is
  // derived from the date rather than asked of the admin. Any date is valid —
  // there have been non-weekend games historically too.
  const league = deriveLeagueFromDate(date);

  // The registration window is normally computed from the league's usual
  // weekly pattern (cutoff the day before) — for a same-day or otherwise
  // irregular one-off game, that computed window can already be in the past
  // by the time the game is created, leaving it dead-on-arrival. The create
  // form always sends its own computed-default preview unless the admin
  // overrides it, so this only ever diverges from the plain default when
  // they explicitly changed it.
  let cutoffOverrideIso: string | null = null;
  if (input.cutoffOverrideRaw && input.cutoffOverrideRaw.trim() !== "") {
    try {
      cutoffOverrideIso = parseEasternDateTimeToUtc(input.cutoffOverrideRaw).toISOString();
    } catch {
      return { ok: false, error: "Enter a valid cutoff date/time." };
    }
  }

  // Distinct id scheme from the cron's `matchday-<date>` (recurring games are
  // always unique-per-date already) so a one-off game can't collide with a
  // same-date-different-league recurring row.
  const gameId = `matchday-${date}-${league}`;

  const client = createServiceRoleClient();
  const { error } = await client.from("scheduled_games").insert({
    game_id: gameId,
    date,
    league,
    kickoff_label: kickoffLabel,
    venue,
    is_recurring: false,
    created_by: admin.canonicalId,
    registration_cutoff_override: cutoffOverrideIso,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { ok: false, error: "A game already exists on that date/league." };
    }
    return { ok: false, error: "Could not create that game." };
  }

  revalidatePath("/matchday");
  revalidatePath(`/matchday/${gameId}`);
  return { ok: true };
}

/**
 * Edits an already-scheduled game's kickoff/venue/registration-cutoff —
 * deliberately never its date or league (see the plan's "scoped out"
 * decision: game_id is deterministically derived from date+league and
 * referenced by FK from game_checkins/draft_sessions/etc., so changing
 * either would mean migrating every referencing row — cancel + recreate
 * remains the path for a genuinely wrong date/league). Works for one-off
 * AND recurring (cron-generated) games alike — both are just rows in the
 * same table, looked up by their existing game_id.
 */
export async function updateScheduledGame(
  gameId: string,
  input: { kickoffLabel: string; venue: string; cutoffOverrideRaw: string | null },
): Promise<MatchdayActionResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const kickoffLabel = input.kickoffLabel.trim();
  const venue = input.venue.trim();
  if (!kickoffLabel) return { ok: false, error: "Kickoff time can't be empty." };
  if (!venue) return { ok: false, error: "Venue can't be empty." };

  let cutoffOverrideIso: string | null = null;
  if (input.cutoffOverrideRaw && input.cutoffOverrideRaw.trim() !== "") {
    try {
      cutoffOverrideIso = parseEasternDateTimeToUtc(input.cutoffOverrideRaw).toISOString();
    } catch {
      return { ok: false, error: "Enter a valid cutoff date/time." };
    }
  }

  const client = createServiceRoleClient();
  const { error } = await client
    .from("scheduled_games")
    .update({
      kickoff_label: kickoffLabel,
      venue,
      registration_cutoff_override: cutoffOverrideIso,
    })
    .eq("game_id", gameId);

  if (error) return { ok: false, error: "Could not update that game." };

  revalidatePath("/matchday");
  revalidatePath(`/matchday/${gameId}`);
  revalidatePath(`/matchday/${gameId}/edit`);
  return { ok: true };
}

export interface PasteRosterResult {
  ok: true;
  checkedIn: string[];
  alreadyCheckedIn: string[];
  provisioned: string[];
  flagged: { raw: string; closestMatch: string | null }[];
}

/**
 * Bulk check-in from a plain pasted roster list — one name per line, no "N
 * people" header or team split needed (unlike the report parser's rosters,
 * these people haven't necessarily logged in themselves, e.g. Vadim's
 * pre-game "here's who's coming" email). Uses the same fuzzy identity
 * resolution as the report parser (resolvePlayerName), not a naive exact-slug
 * match like checkInNewPlayer's single-name path — bulk-pasting many names
 * at once has a much higher chance of colliding with an already-known
 * player under a slightly different spelling, so a flagged near-miss is
 * surfaced for a human to confirm rather than silently creating a duplicate
 * identity.
 */
export async function checkInPastedRoster(
  gameId: string,
  rawText: string,
): Promise<PasteRosterResult | { ok: false; error: string }> {
  // Inlined rather than requireAdminResult() — that helper's return type is
  // exactly MatchdayActionResult ({ok:true}|{ok:false,error}), and this
  // function's own {ok:true} shape (PasteRosterResult) has extra required
  // fields, so the two "ok:true" shapes would be indistinguishable to callers
  // narrowing on `.ok` alone.
  const admin = await getCurrentUser();
  if (!admin?.isAdmin) return { ok: false, error: "Admin access required." };

  const client = createServiceRoleClient();

  const { data: gameRow } = await client.from("scheduled_games").select("league").eq("game_id", gameId).maybeSingle();
  if (!gameRow) return { ok: false, error: "Game not found." };

  // Strips zero-width/BOM characters Gmail/Google Docs copy-paste sometimes
  // leaves at the start of a line (confirmed on a real pasted list), not
  // just plain whitespace.
  const names = rawText
    .split("\n")
    .map((line) => stripZeroWidthChars(line).trim())
    .filter(Boolean);
  if (names.length === 0) return { ok: false, error: "Paste at least one name." };

  const { data: playerRows } = await client
    .from("players")
    .select("canonical_id, display_name, roster_name, aliases, known_emails, leagues, status");
  const knownPlayers: PlayerIdentity[] = (playerRows ?? []).map((row) => ({
    canonicalId: row.canonical_id,
    displayName: row.display_name,
    rosterName: row.roster_name,
    aliases: row.aliases ?? [],
    knownEmails: row.known_emails ?? [],
    leagues: row.leagues ?? [],
    status: row.status,
  }));

  const { data: existingCheckins } = await client
    .from("game_checkins")
    .select("canonical_id")
    .eq("game_id", gameId)
    .is("removed_at", null);
  const checkedInIds = new Set((existingCheckins ?? []).map((r) => r.canonical_id));

  const provisioned: PlayerIdentity[] = [];
  const flagged: { raw: string; closestMatch: string | null }[] = [];
  const toCheckIn: { canonicalId: string; displayName: string }[] = [];
  const alreadyCheckedIn: string[] = [];

  for (const raw of names) {
    const resolution = resolvePlayerName(raw, [...knownPlayers, ...provisioned]);
    let canonicalId: string;
    let displayName: string;

    if (resolution.status === "exact" && resolution.canonicalId) {
      canonicalId = resolution.canonicalId;
      displayName = knownPlayers.find((p) => p.canonicalId === canonicalId)?.displayName ?? raw;
    } else if (resolution.status === "flagged") {
      flagged.push({ raw, closestMatch: resolution.candidates[0]?.displayName ?? null });
      continue;
    } else if (!isPlausiblePlayerName(raw)) {
      // A pasted line that's really a note ("Ari (15, new guy)") never becomes a public player.
      flagged.push({ raw, closestMatch: null });
      continue;
    } else {
      const provisional = createProvisionalIdentity(raw);
      provisioned.push({ ...provisional, leagues: [gameRow.league as ScheduledLeague] });
      canonicalId = provisional.canonicalId;
      displayName = provisional.displayName;
    }

    if (checkedInIds.has(canonicalId)) {
      alreadyCheckedIn.push(displayName);
    } else {
      toCheckIn.push({ canonicalId, displayName });
      checkedInIds.add(canonicalId); // a repeated line in the paste shouldn't double-insert
    }
  }

  if (provisioned.length > 0) {
    const { error } = await client.from("players").upsert(
      provisioned.map((p) => ({
        canonical_id: p.canonicalId,
        display_name: p.displayName,
        aliases: p.aliases,
        known_emails: p.knownEmails,
        leagues: p.leagues,
        status: p.status,
      })),
    );
    if (error) return { ok: false, error: "Could not save the new players from this roster." };
  }

  if (toCheckIn.length > 0) {
    const { error } = await client.from("game_checkins").insert(
      toCheckIn.map((p) => ({ game_id: gameId, canonical_id: p.canonicalId, checked_in_by: admin.canonicalId })),
    );
    if (error) return { ok: false, error: "Could not check in these players." };
  }

  revalidateGamePaths(gameId);
  return {
    ok: true,
    checkedIn: toCheckIn.map((p) => p.displayName),
    alreadyCheckedIn,
    provisioned: provisioned.map((p) => p.displayName),
    flagged,
  };
}
