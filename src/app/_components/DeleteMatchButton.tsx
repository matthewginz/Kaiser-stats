"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { formatMatchDateLabel } from "@/lib/format";
import { deleteMatch } from "@/lib/report-parser/actions";

export function DeleteMatchButton({ gameId, date }: { gameId: string; date: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const confirmed = window.confirm(
      `Delete the match on ${formatMatchDateLabel(date)}? Its score, rosters, goals and MVP are removed from every stat. This can't be undone.`,
    );
    if (!confirmed) return;

    startTransition(async () => {
      try {
        const result = await deleteMatch(gameId);
        if (!result.ok) {
          alert(result.error);
          return;
        }
        router.push(`/matches?year=${date.slice(0, 4)}`);
      } catch {
        alert("Something went wrong — please try again.");
      }
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      className="delete-match-button"
      aria-label={`Delete match on ${formatMatchDateLabel(date)}`}
      title="Delete this match"
    >
      ×
    </button>
  );
}
