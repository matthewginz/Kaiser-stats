"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "../auth/session";
import { deriveLeagueFromDate } from "../matchday/registration-window";
import { createServiceRoleClient } from "../supabase/client";
import type { GameRecord, NameResolution, PlayerIdentity } from "../stats-engine/types";
import { validateMatchEdit, type MatchEditInput } from "./edit-match";
import { parseReportText, resolveExtractionToGameRecord } from "./parse-report";
import { findExistingDraftGameId, mergeReportIntoDraftGame, saveResolvedGame, type SaveResult } from "./save";

export interface ReportPreview {
  gameRecord: GameRecord;
  /** Every canonicalId referenced above (known + newly provisioned), resolved for rendering. */
  displayNames: Record<string, string>;
  /** Same keys as displayNames — null for anyone with no roster name set (e.g. every provisioned player, always). */
  rosterNames: Record<string, string | null>;
  provisionedPlayers: PlayerIdentity[];
  flaggedNames: NameResolution[];
  goalSumMismatch: boolean;
  firstPickWarning: string | null;
  pickOrderWarning: string | null;
  /** See ResolvedReport's doc comment — always shown to the admin as a yes/no question, never silently trusted either way. */
  rosterOrderIsDraftOrder: boolean;
}

type PreviewResult = { ok: true; preview: ReportPreview } | { ok: false; error: string };

/**
 * Every action here independently re-checks admin-ness — Server Actions are
 * reachable regardless of which page's JSX references them, same reasoning
 * as requireAdminResult() in src/lib/matchday/actions.ts (not shared across
 * modules, matching that file's existing convention).
 */
async function requireAdminResult(): Promise<{ canonicalId: string } | { ok: false; error: string }> {
  const admin = await getCurrentUser();
  if (!admin?.isAdmin) return { ok: false, error: "Admin access required." };
  return admin;
}

async function fetchKnownPlayers(): Promise<PlayerIdentity[]> {
  const client = createServiceRoleClient();
  const { data } = await client
    .from("players")
    .select("canonical_id, display_name, roster_name, aliases, known_emails, leagues, status");

  return (data ?? []).map((row) => ({
    canonicalId: row.canonical_id,
    displayName: row.display_name,
    rosterName: row.roster_name,
    aliases: row.aliases ?? [],
    knownEmails: row.known_emails ?? [],
    leagues: row.leagues ?? [],
    status: row.status,
  }));
}

function buildDisplayNames(known: PlayerIdentity[], provisioned: PlayerIdentity[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of [...known, ...provisioned]) map[p.canonicalId] = p.displayName;
  return map;
}

function buildRosterNames(known: PlayerIdentity[], provisioned: PlayerIdentity[]): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const p of [...known, ...provisioned]) map[p.canonicalId] = p.rosterName ?? null;
  return map;
}

export async function previewReportImport(input: {
  text: string;
  firstPickRaw: string | null;
  manualResolutions?: Record<string, string>;
  /** The admin's yes/no answer to "is the roster listing above real draft order?" — see ResolvedReport's doc comment. Null/omitted means not answered yet. */
  rosterOrderIsDraftOrder?: boolean | null;
}): Promise<PreviewResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const text = input.text.trim();
  if (!text) return { ok: false, error: "Paste the report text first." };

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEY is not configured on the server." };

  const knownPlayers = await fetchKnownPlayers();

  let extraction;
  try {
    extraction = await parseReportText(apiKey, text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Report parsing failed." };
  }

  // Date used to be typed in separately by the admin, but the pasted thread
  // always already states it (the original email's date line/subject, e.g.
  // "Saturday, June 27" or "Vadim ..., 2026-06-27:") — so Gemini's own
  // extraction (see prompt.ts's date field) is now the only source. No silent
  // fallback to "today": a wrong guess here would produce a wrong gameId and
  // a mislabeled game record, so this is a hard error instead, telling the
  // admin to make sure that line is in the pasted text.
  if (!extraction.date) {
    return {
      ok: false,
      error: "Couldn't find a date in that text — make sure the pasted thread includes the original date/subject line.",
    };
  }

  // League is derived from the date's actual day of the week
  // (deriveLeagueFromDate), not trusted from Gemini's own "league" field —
  // confirmed project rule (2026-07-20): only a genuine Sunday counts as the
  // Sunday league; every other day (including an irregular one-off like a
  // Monday holiday game or a Friday game) buckets into Saturday's data,
  // since those off-day games are normally played at Kaiser (Saturday's
  // venue) anyway. This also means there's no more "unknown" league case to
  // hard-error on — every date maps definitively to one or the other.
  const league = deriveLeagueFromDate(extraction.date);

  const gameId = `report-${extraction.date}-${league}`;
  const source = `manual:${extraction.date}-${league}`;

  const resolved = resolveExtractionToGameRecord(
    extraction,
    knownPlayers,
    { gameId, source, fallbackDate: extraction.date, fallbackLeague: league },
    input.firstPickRaw,
    input.manualResolutions,
    input.rosterOrderIsDraftOrder,
  );

  return {
    ok: true,
    preview: {
      gameRecord: resolved.gameRecord,
      displayNames: buildDisplayNames(knownPlayers, resolved.provisionedPlayers),
      rosterNames: buildRosterNames(knownPlayers, resolved.provisionedPlayers),
      provisionedPlayers: resolved.provisionedPlayers,
      flaggedNames: resolved.flaggedNames,
      goalSumMismatch: resolved.goalSumMismatch,
      firstPickWarning: resolved.firstPickWarning,
      pickOrderWarning: resolved.pickOrderWarning,
      rosterOrderIsDraftOrder: resolved.rosterOrderIsDraftOrder,
    },
  };
}

/** Every non-deferred player, for the "pick a different player" search when resolving a flagged name — unlike the draft pool picker, this deliberately includes 'provisional' rows (an unresolved name's correct target is very often exactly one of those). */
export async function listPlayersForNameResolution(): Promise<{ canonicalId: string; displayName: string }[]> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return [];

  const client = createServiceRoleClient();
  const { data } = await client
    .from("players")
    .select("canonical_id, display_name")
    .neq("status", "deferred")
    .order("display_name");

  return (data ?? []).map((row) => ({ canonicalId: row.canonical_id, displayName: row.display_name }));
}

/**
 * Permanently remembers each flagged-name decision confirmed in the preview
 * (see ReportImportForm's "Accept"/"pick a player" controls) — appends the
 * raw text as an alias on the chosen player (so it auto-resolves next time,
 * no re-confirming) and writes an already-resolved unresolved_names_log row
 * as the audit trail: keeps every raw-name-to-player merge decision as its
 * own record, separate from the alias list itself, so a bad merge can be
 * identified and undone (drop the alias, clear the log row) without having
 * to reverse-engineer which report caused it.
 */
async function persistManualResolutions(
  client: ReturnType<typeof createServiceRoleClient>,
  resolutions: { raw: string; canonicalId: string }[],
  source: string,
): Promise<void> {
  if (resolutions.length === 0) return;

  await Promise.all(
    resolutions.map(async ({ raw, canonicalId }) => {
      const { data: player } = await client
        .from("players")
        .select("aliases")
        .eq("canonical_id", canonicalId)
        .maybeSingle();
      if (!player) return;

      const aliases: string[] = player.aliases ?? [];
      const alreadyKnown = aliases.some((a: string) => a.trim().toLowerCase() === raw.trim().toLowerCase());
      if (!alreadyKnown) {
        await client
          .from("players")
          .update({ aliases: [...aliases, raw.trim()] })
          .eq("canonical_id", canonicalId);
      }

      await client.from("unresolved_names_log").insert({
        raw_name: raw.trim(),
        status: "flagged",
        candidate_canonical_id: canonicalId,
        candidate_distance: null,
        source,
        resolved_at: new Date().toISOString(),
        resolved_canonical_id: canonicalId,
      });
    }),
  );
}

export async function saveReportImport(
  preview: ReportPreview,
  rawText: string,
  confirmedResolutions?: { raw: string; canonicalId: string }[],
): Promise<SaveResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const client = createServiceRoleClient();

  // A live draft may have already created a real game_records row for this exact
  // date/league (see draft-actions.ts's finalizeDraft) — its roster/pick numbers are
  // ground truth, not this parse's estimate, so this report only ever fills in the
  // score/goals/MVP on top of it rather than inserting a second, conflicting row.
  const existingDraftGameId = await findExistingDraftGameId(
    client,
    preview.gameRecord.date,
    preview.gameRecord.league,
  );

  const result = existingDraftGameId
    ? await mergeReportIntoDraftGame(client, {
        draftGameId: existingDraftGameId,
        gameRecord: preview.gameRecord,
        provisionedPlayers: preview.provisionedPlayers,
        flaggedNames: preview.flaggedNames,
        rawText,
      })
    : await saveResolvedGame(client, {
        gameRecord: preview.gameRecord,
        provisionedPlayers: preview.provisionedPlayers,
        flaggedNames: preview.flaggedNames,
        rawText,
      });

  if (result.ok) {
    await persistManualResolutions(client, confirmedResolutions ?? [], preview.gameRecord.source);
  }

  // Invalidate /matches server-side, authoritatively, right here — the
  // client just navigates there afterward with a plain router.push(), no
  // extra router.refresh() needed (and no risk of the router.push()+
  // router.refresh() race that was leaving the UI stuck on "Saving..."
  // looking done-but-frozen even though the save itself had already
  // succeeded — see ReportImportForm.tsx's handleSave).
  if (result.ok) revalidatePath("/matches");
  return result;
}

/** Deletes a saved match (report-imported, draft-created, or backfilled) — its roster_spots/goal_events/notable_mentions cascade with it, see saveResolvedGame's rollbackAndFail comment. */
export async function deleteMatch(gameId: string): Promise<SaveResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const client = createServiceRoleClient();
  const { error } = await client.from("game_records").delete().eq("game_id", gameId);
  if (error) return { ok: false, error: "Could not delete that match." };

  revalidatePath("/", "layout");
  return { ok: true };
}

/** Edits a saved match's score, MVP, and report text. Rosters/goals aren't editable here — delete and re-import the report for those. */
export async function updateMatch(gameId: string, input: MatchEditInput): Promise<SaveResult> {
  const admin = await requireAdminResult();
  if ("ok" in admin) return admin;

  const validated = validateMatchEdit(input);
  if (!validated.ok) return validated;
  const { homeScore, awayScore, mvpCanonicalId, description } = validated.edit;

  const client = createServiceRoleClient();
  const { data, error } = await client
    .from("game_records")
    .update({ home_score: homeScore, away_score: awayScore, mvp_canonical_id: mvpCanonicalId, description })
    .eq("game_id", gameId)
    .select("game_id");
  if (error) return { ok: false, error: "Could not save that match." };
  if (!data || data.length === 0) return { ok: false, error: "That match no longer exists." };

  revalidatePath("/", "layout");
  return { ok: true };
}
