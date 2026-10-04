"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateMatch } from "@/lib/report-parser/actions";
import { useToast } from "./ToastProvider";

export function EditMatchForm({
  gameId,
  homeLabel,
  awayLabel,
  homeScore,
  awayScore,
  mvpCanonicalId,
  description,
  mvpOptions,
}: {
  gameId: string;
  homeLabel: string;
  awayLabel: string;
  homeScore: number | null;
  awayScore: number | null;
  mvpCanonicalId: string | null;
  description: string;
  mvpOptions: { canonicalId: string; name: string }[];
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [homeScoreRaw, setHomeScoreRaw] = useState(homeScore?.toString() ?? "");
  const [awayScoreRaw, setAwayScoreRaw] = useState(awayScore?.toString() ?? "");
  const [mvp, setMvp] = useState(mvpCanonicalId ?? "");
  const [text, setText] = useState(description);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await updateMatch(gameId, {
          homeScoreRaw,
          awayScoreRaw,
          mvpCanonicalId: mvp,
          description: text,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        showToast("success", "Match saved.");
        router.push(`/matches/${gameId}`);
      } catch {
        setError("Something went wrong — please try again.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="login-form">
      <label htmlFor="edit-match-home" className="login-form-label">
        {homeLabel} score
      </label>
      <input
        id="edit-match-home"
        type="text"
        inputMode="numeric"
        value={homeScoreRaw}
        onChange={(e) => setHomeScoreRaw(e.target.value)}
        className="login-form-input"
        disabled={isPending}
      />

      <label htmlFor="edit-match-away" className="login-form-label">
        {awayLabel} score
      </label>
      <input
        id="edit-match-away"
        type="text"
        inputMode="numeric"
        value={awayScoreRaw}
        onChange={(e) => setAwayScoreRaw(e.target.value)}
        className="login-form-input"
        disabled={isPending}
      />
      <p className="note">Leave both scores blank for a no-report game.</p>

      <label htmlFor="edit-match-mvp" className="login-form-label">
        MVP
      </label>
      <select
        id="edit-match-mvp"
        value={mvp}
        onChange={(e) => setMvp(e.target.value)}
        className="login-form-input"
        disabled={isPending}
      >
        <option value="">No MVP</option>
        {mvpOptions.map((p) => (
          <option key={p.canonicalId} value={p.canonicalId}>
            {p.name}
          </option>
        ))}
      </select>

      <label htmlFor="edit-match-report" className="login-form-label">
        Report text
      </label>
      <textarea
        id="edit-match-report"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="login-form-input report-import-textarea"
        rows={12}
        disabled={isPending}
      />

      {error && <p className="note login-form-error">{error}</p>}

      <button type="submit" className="login-form-submit" disabled={isPending}>
        {isPending ? "Saving..." : "Save match"}
      </button>
    </form>
  );
}
