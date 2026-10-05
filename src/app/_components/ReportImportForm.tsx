"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  listPlayersForNameResolution,
  previewReportImport,
  saveReportImport,
  type ReportPreview,
} from "@/lib/report-parser/actions";
import { NEW_PLAYER_RESOLUTION } from "@/lib/report-parser/types";
import { isPlausiblePlayerName } from "@/lib/stats-engine/identity";
import { formatScoreLine, getMultiGoalNickname } from "@/lib/format";
import { summarizePlayerGameStats } from "@/lib/stats-engine/goal-summary";
import { rosterDisplayName } from "@/lib/stats-engine/identity";
import { AssistChip } from "./AssistChip";
import { GoalChip } from "./GoalChip";

export function ReportImportForm({ currentUserCanonicalId }: { currentUserCanonicalId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isParsing, startParsing] = useTransition();
  const [isSaving, startSaving] = useTransition();
  const [allPlayers, setAllPlayers] = useState<{ canonicalId: string; displayName: string }[]>([]);
  // Keyed by raw.trim().toLowerCase() — matches resolveExtractionToGameRecord's
  // own lookup key, so a re-preview resolves this raw name every time it
  // reappears regardless of casing. Re-sent on every re-parse of this same
  // text so an earlier confirmation in this session survives a second edit.
  const [manualResolutions, setManualResolutions] = useState<Record<string, string>>({});
  // Original-cased raw text per confirmed name, kept separately from
  // manualResolutions (which is normalized for matching) — this is what
  // actually gets written as a player alias on Save, and needs to read
  // naturally rather than as a lowercased lookup key.
  const [confirmedResolutions, setConfirmedResolutions] = useState<{ raw: string; canonicalId: string }[]>([]);
  const [pickerDrafts, setPickerDrafts] = useState<Record<string, string>>({});
  // The admin's explicit yes/no answer to "is the roster listing real draft
  // order?" (see ResolvedReport's doc comment) — null until answered, in
  // which case the preview shows the team-label heuristic's own guess
  // instead. Re-sent on every re-parse of this same text, same reasoning as
  // manualResolutions: an earlier answer must survive a flagged-name fix.
  const [rosterOrderOverride, setRosterOrderOverride] = useState<boolean | null>(null);

  useEffect(() => {
    listPlayersForNameResolution().then(setAllPlayers).catch(() => {});
  }, []);

  function identityFor(canonicalId: string): { displayName: string; rosterName?: string | null } {
    return {
      displayName: preview?.displayNames[canonicalId] ?? canonicalId,
      rosterName: preview?.rosterNames[canonicalId] ?? null,
    };
  }

  function nameFor(canonicalId: string): string {
    return rosterDisplayName(identityFor(canonicalId));
  }

  /**
   * Bolds whoever is logged in, wherever a name renders — instead of baking
   * a "(you)" marker into stored data. Optionally also colors the name by
   * team (Stats list only) so it's visually clear who played on which side.
   * Also tags the determined MVP with the same ribbon icon MvpBadge uses,
   * inline next to their name wherever it renders (roster or Stats list) —
   * simpler than a separate "MVP" section, and guarantees it's visible even
   * for the rare MVP with no stats line of their own (a 0-goal/assist game).
   */
  function renderName(canonicalId: string, team?: "home" | "away") {
    const name = nameFor(canonicalId);
    const isYou = canonicalId === currentUserCanonicalId;
    const isMvp = canonicalId === preview?.gameRecord.mvpCanonicalId;
    const mvpIcon = isMvp && (
      <span aria-label="MVP Pick" title="MVP Pick">
        {" "}
        🎖️
      </span>
    );
    if (!team) return isYou ? <strong>{name}{mvpIcon}</strong> : <>{name}{mvpIcon}</>;
    const className = `match-detail-scorer-name-${team}`;
    return isYou ? (
      <strong className={className}>{name}{mvpIcon}</strong>
    ) : (
      <span className={className}>{name}{mvpIcon}</span>
    );
  }

  function renderNameList(canonicalIds: string[]) {
    if (canonicalIds.length === 0) return "—";
    return canonicalIds.map((id, i) => (
      <span key={id}>
        {i > 0 && ", "}
        {renderName(id)}
      </span>
    ));
  }

  function handleParse(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPreview(null);
    setManualResolutions({});
    setConfirmedResolutions([]);
    setPickerDrafts({});
    setRosterOrderOverride(null);

    startParsing(async () => {
      try {
        const result = await previewReportImport({
          text,
          // The default snake-order/team-listed-first-picks-first convention
          // (see parse-report.ts's resolveExtractionToGameRecord) now covers
          // the common case automatically — this manual override still exists
          // server-side for the rare game where it's wrong, just not exposed
          // in this form anymore.
          firstPickRaw: null,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPreview(result.preview);
      } catch {
        setError("Something went wrong parsing that report — please try again.");
      }
    });
  }

  /**
   * Confirms a flagged name is really a specific known player — either
   * accepting the suggested candidate or a manual pick from the search
   * dropdown. Re-parses immediately so this game's own roster/goals/stats
   * include them right away; the alias itself (remembered for every future
   * report) is only written once Save actually succeeds, in saveReportImport.
   */
  function handleResolveFlaggedName(raw: string, canonicalId: string) {
    const key = raw.trim().toLowerCase();
    const nextManual = { ...manualResolutions, [key]: canonicalId };
    setManualResolutions(nextManual);
    // A brand-new player has no existing player to alias onto — saving
    // creates them from preview.provisionedPlayers instead.
    setConfirmedResolutions((prev) => [
      ...prev.filter((r) => r.raw.trim().toLowerCase() !== key),
      ...(canonicalId === NEW_PLAYER_RESOLUTION ? [] : [{ raw, canonicalId }]),
    ]);

    setError(null);
    startParsing(async () => {
      try {
        const result = await previewReportImport({
          text,
          firstPickRaw: null,
          manualResolutions: nextManual,
          rosterOrderIsDraftOrder: rosterOrderOverride,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPreview(result.preview);
      } catch {
        setError("Something went wrong re-checking that report — please try again.");
      }
    });
  }

  /** The admin's explicit yes/no answer to the roster-order question — re-checks the report immediately so pick numbers update right away. */
  function handleSetRosterOrder(value: boolean) {
    setRosterOrderOverride(value);
    setError(null);
    startParsing(async () => {
      try {
        const result = await previewReportImport({
          text,
          firstPickRaw: null,
          manualResolutions,
          rosterOrderIsDraftOrder: value,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPreview(result.preview);
      } catch {
        setError("Something went wrong re-checking that report — please try again.");
      }
    });
  }

  function handleSave() {
    if (!preview) return;
    setError(null);
    startSaving(async () => {
      try {
        const result = await saveReportImport(preview, text, confirmedResolutions);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        // No router.refresh() here — saveReportImport already revalidated
        // /matches server-side, so a plain push shows fresh data. Calling
        // both was racy and could leave this button stuck on "Saving..."
        // even after the save had genuinely already succeeded.
        router.push("/matches");
      } catch {
        setError("Something went wrong saving that report — please try again.");
      }
    });
  }

  const isPending = isParsing || isSaving;
  const stats = preview ? summarizePlayerGameStats(preview.gameRecord.goals) : [];

  return (
    <>
      {!preview && (
      <form onSubmit={handleParse} className="report-import-form">
        <label htmlFor="report-text" className="login-form-label">
          Report text
        </label>
        <textarea
          id="report-text"
          required
          placeholder="Paste the full report email thread, including the original date/subject line and every reply, in order. The date and league are read from this text, not typed in separately."
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="login-form-input report-import-textarea"
          rows={16}
          disabled={isPending}
        />

        {error && <p className="note login-form-error">{error}</p>}

        <button type="submit" className="login-form-submit" disabled={isPending}>
          {isParsing ? "Confirming..." : "Confirm"}
        </button>
      </form>
      )}

      {preview && (
        <section className="card report-import-preview">
          <h2>Preview</h2>
          <p className="player-summary-line">
            {preview.gameRecord.date} · {preview.gameRecord.league} ·{" "}
            {formatScoreLine(preview.gameRecord.homeScore, preview.gameRecord.awayScore)}
          </p>

          {preview.goalSumMismatch && (
            <p className="report-import-warning">
              Goal count doesn&apos;t match the stated score — double-check before saving.
            </p>
          )}
          {preview.firstPickWarning && <p className="report-import-warning">{preview.firstPickWarning}</p>}
          {preview.pickOrderWarning && <p className="report-import-warning">{preview.pickOrderWarning}</p>}

          <div className="report-import-roster-order">
            <p className="note">Is the roster listing below the real draft order?</p>
            <div className="report-import-roster-order-buttons">
              <button
                type="button"
                className={preview.rosterOrderIsDraftOrder ? "login-form-submit" : "edit-game-button"}
                disabled={isPending}
                onClick={() => handleSetRosterOrder(true)}
              >
                Yes, draft order
              </button>
              <button
                type="button"
                className={!preview.rosterOrderIsDraftOrder ? "login-form-submit" : "edit-game-button"}
                disabled={isPending}
                onClick={() => handleSetRosterOrder(false)}
              >
                No, just who played
              </button>
            </div>
            {rosterOrderOverride === null && (
              <p className="note">Not answered yet — showing the automatic guess below. Pick one to confirm it.</p>
            )}
          </div>

          <h3>{preview.gameRecord.homeTeamLabel} roster</h3>
          <p>{renderNameList(preview.gameRecord.homeRoster.map((s) => s.canonicalId))}</p>

          <h3>{preview.gameRecord.awayTeamLabel} roster</h3>
          <p>{renderNameList(preview.gameRecord.awayRoster.map((s) => s.canonicalId))}</p>

          {stats.length > 0 && (
            <>
              <h3>Stats</h3>
              <ul className="match-detail-goal-list">
                {stats.map((stat) => {
                  const nickname = getMultiGoalNickname(stat.goals);
                  return (
                    <li key={stat.canonicalId} className={`match-detail-goal-${stat.team}`}>
                      <span className="match-detail-scorer-name">{renderName(stat.canonicalId, stat.team)}</span>
                      <GoalChip count={stat.goals} />
                      <AssistChip count={stat.assists} />
                      {nickname && <span className="match-detail-goal-nickname">{nickname}</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {preview.flaggedNames.length > 0 && (
            <div className="report-import-flag-list">
              <h3>Flagged names (excluded — needs a human decision)</h3>
              <ul>
                {preview.flaggedNames.map((f) => {
                  const candidate = f.candidates[0];
                  const draft = pickerDrafts[f.raw] ?? "";
                  return (
                    <li key={f.raw}>
                      <div>
                        &ldquo;{f.raw}&rdquo;
                        {candidate && ` — closest match: ${candidate.displayName} (distance ${candidate.distance})`}
                      </div>
                      <div className="report-import-flag-actions">
                        {candidate && (
                          <button
                            type="button"
                            className="login-form-resend"
                            disabled={isPending}
                            onClick={() => handleResolveFlaggedName(f.raw, candidate.canonicalId)}
                          >
                            Accept: {candidate.displayName}
                          </button>
                        )}
                        <select
                          className="login-form-input"
                          value={draft}
                          disabled={isPending}
                          onChange={(e) => setPickerDrafts((d) => ({ ...d, [f.raw]: e.target.value }))}
                        >
                          <option value="">Pick a different player…</option>
                          {allPlayers.map((p) => (
                            <option key={p.canonicalId} value={p.canonicalId}>
                              {p.displayName}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="login-form-resend"
                          disabled={isPending || !draft}
                          onClick={() => handleResolveFlaggedName(f.raw, draft)}
                        >
                          Use this
                        </button>
                        {isPlausiblePlayerName(f.raw) && (
                          <button
                            type="button"
                            className="login-form-resend"
                            disabled={isPending}
                            onClick={() => handleResolveFlaggedName(f.raw, NEW_PLAYER_RESOLUTION)}
                          >
                            Add as new player: {f.raw}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {preview.provisionedPlayers.length > 0 && (
            <div className="report-import-flag-list">
              <h3>New players auto-tracked</h3>
              <p>{preview.provisionedPlayers.map((p) => p.displayName).join(", ")}</p>
            </div>
          )}

          <div className="report-import-preview-actions">
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="login-form-resend"
              disabled={isPending}
            >
              ← Edit
            </button>
            <button type="button" onClick={handleSave} className="login-form-submit" disabled={isPending}>
              {isSaving ? "Saving..." : "Save to database"}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
