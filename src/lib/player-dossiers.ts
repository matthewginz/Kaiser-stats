/**
 * Published Claude "player dossiers" — long-form scouting write-ups for a
 * handful of players, linked from their profile page. Keyed by canonicalId.
 *
 * These live outside the app (claude.ai artifacts): a deep-dive companion to
 * the in-app stats, not part of them. Each is a point-in-time snapshot (it
 * states the date its data was pulled), so `snapshot` is shown next to the
 * link to make a stale one obvious. Hand-maintained — add a row when a new
 * dossier is published, and refresh `snapshot` if a dossier is re-generated.
 */
export interface PlayerDossier {
  /** The published artifact URL. */
  url: string;
  /** When the dossier's underlying data was pulled (e.g. "September 2026"). */
  snapshot: string;
  /** One line, shown on the profile — the dossier's own thesis. */
  blurb: string;
}

export const PLAYER_DOSSIERS: Record<string, PlayerDossier> = {
  // Isaac
  "auto-isaac": {
    url: "https://claude.ai/code/artifact/616db646-c378-4cc8-9396-452a706b1c6e",
    snapshot: "September 2026",
    blurb:
      "Placement finisher and counter-attack specialist — drafted his way from last pick to the second round in three seasons.",
  },
  // Matthew ("Matushka" / "Matthiew")
  "001b": {
    url: "https://claude.ai/code/artifact/0c042974-882e-400e-9116-2045873218fe",
    snapshot: "September 2026",
    blurb:
      "The league's fastest finisher — a top-six pick since week one, through a lost 2025 and back to a career-best 2026.",
  },
  // Matt (Matthew Rakov)
  "001a": {
    url: "https://claude.ai/code/artifact/f63b9925-c2da-460d-a66e-96cfda26bfc5",
    snapshot: "September 2026",
    blurb:
      "From near-last pick to consensus first overall in two years — the biggest re-rating in the league, built on work-rate.",
  },
  // Vadim Palmer
  "004": {
    url: "https://claude.ai/artifact/LR6B4kHkPL7AZTNJq9aTSX",
    snapshot: "October 2026",
    blurb: "The league's organizer, captain and go-to goalkeeper — 429 games, the most of anyone, and his value never shows up on the scoresheet.",
  },
};

export function getPlayerDossier(canonicalId: string): PlayerDossier | undefined {
  return PLAYER_DOSSIERS[canonicalId];
}
