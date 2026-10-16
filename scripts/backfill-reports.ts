// Bulk historical backfill: parses every .txt report file in a directory
// through the exact same parser + identity-resolution + Supabase write path
// as the admin web UI (src/lib/report-parser/), instead of pasting each one
// into /matches/import by hand. Safe to re-run — a file whose game already
// exists (same date/league game_id) is skipped, not duplicated.
//
// Usage: npm run backfill-reports -- [directory]
// Defaults to private/sample-reports/ if no directory is given. Each file's
// game_id/source is derived from its filename (e.g. 2026-07-05-sunday.txt),
// same convention as scripts/parse-report.ts. Supports an optional
// "First pick: <name>" annotation line, same as that script.

import { config } from "dotenv";
config({ path: ".env.local" });
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { deriveLeagueFromDate } from "../src/lib/matchday/registration-window";
import { extractFirstPickAnnotation, parseReportText, resolveExtractionToGameRecord } from "../src/lib/report-parser/parse-report";
import { saveResolvedGame } from "../src/lib/report-parser/save";
import { createServiceRoleClient } from "../src/lib/supabase/client";
import type { PlayerIdentity } from "../src/lib/stats-engine/types";

const FILENAME_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

const DEFAULT_DIR = path.join("private", "sample-reports");

async function fetchKnownPlayers(client: ReturnType<typeof createServiceRoleClient>): Promise<PlayerIdentity[]> {
  const { data } = await client
    .from("players")
    .select("canonical_id, display_name, aliases, known_emails, leagues, status");

  return (data ?? []).map((row) => ({
    canonicalId: row.canonical_id,
    displayName: row.display_name,
    aliases: row.aliases ?? [],
    knownEmails: row.known_emails ?? [],
    leagues: row.leagues ?? [],
    status: row.status,
  }));
}

async function main() {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY must be set in .env.local");

  const files = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".txt"))
    .sort();

  if (files.length === 0) {
    console.log(`No .txt files found in ${dir}. Nothing to do.`);
    return;
  }

  const client = createServiceRoleClient();
  // Accumulated across files in this run so a name auto-tracked from an
  // earlier file in the batch is recognized as already-known by a later
  // file (correct fuzzy-match flagging, and doesn't re-log the same player
  // as "newly auto-tracked" once per file) — same pattern as
  // scripts/backfill-to-supabase.ts.
  const knownPlayers = await fetchKnownPlayers(client);

  console.log(`Found ${files.length} report file(s) in ${dir}. Loaded ${knownPlayers.length} known players.\n`);

  let saved = 0;
  let skipped = 0;
  let failed = 0;
  let totalProvisioned = 0;
  let totalFlagged = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const gameId = path.basename(file, ".txt");
    const rawFileText = readFileSync(filePath, "utf-8");
    const { firstPickRaw, threadText } = extractFirstPickAnnotation(rawFileText);

    console.log(`--- ${file} ---`);

    let extraction;
    try {
      extraction = await parseReportText(apiKey, threadText);
    } catch (err) {
      console.error(`  FAILED to parse: ${err instanceof Error ? err.message : err}`);
      failed += 1;
      continue;
    }

    // The filename always encodes the real date (e.g. "2025-08-09-saturday.txt")
    // even when the report text itself never states a day name — deriving the
    // league fallback from that date (rather than a hardcoded "unknown") is
    // what the admin web UI's import path does too (see report-parser/actions.ts).
    const filenameDateMatch = FILENAME_DATE_PATTERN.exec(gameId);
    const fallbackDate = filenameDateMatch?.[1] ?? new Date().toISOString().slice(0, 10);
    const fallbackLeague = deriveLeagueFromDate(fallbackDate);

    const resolved = resolveExtractionToGameRecord(
      extraction,
      knownPlayers,
      { gameId, source: `email:${gameId}`, fallbackDate, fallbackLeague },
      firstPickRaw,
    );

    if (resolved.gameRecord.status === "pending_review") {
      console.warn(`  PENDING REVIEW (hidden from public stats until an admin saves it from Edit match): ${resolved.gameRecord.reviewReason}`);
    }
    if (resolved.firstPickWarning) {
      console.warn(`  ${resolved.firstPickWarning}`);
    }
    if (resolved.pickOrderWarning) {
      console.warn(`  ${resolved.pickOrderWarning}`);
    }

    const result = await saveResolvedGame(client, {
      gameRecord: resolved.gameRecord,
      provisionedPlayers: resolved.provisionedPlayers,
      flaggedNames: resolved.flaggedNames,
      rawText: threadText,
    });

    if (!result.ok) {
      if (result.error.includes("already exists")) {
        console.log(`  Skipped — ${result.error}`);
        skipped += 1;
      } else {
        console.error(`  FAILED to save: ${result.error}`);
        failed += 1;
      }
      continue;
    }

    knownPlayers.push(...resolved.provisionedPlayers);
    totalProvisioned += resolved.provisionedPlayers.length;
    totalFlagged += resolved.flaggedNames.length;
    saved += 1;
    console.log(
      `  Saved (${resolved.provisionedPlayers.length} new player(s) auto-tracked, ${resolved.flaggedNames.length} flagged name(s)).`,
    );
  }

  console.log(
    `\nDone. ${saved} saved, ${skipped} skipped (already existed), ${failed} failed.\n` +
      `${totalProvisioned} new players auto-tracked across this run, ${totalFlagged} flagged names logged to unresolved_names_log.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
