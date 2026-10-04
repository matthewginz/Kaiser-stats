import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/session";
import { formatMatchDateLabel } from "@/lib/format";
import { listGameRecords, listPlayers } from "@/lib/stats-engine/data";
import { rosterDisplayName } from "@/lib/stats-engine/identity";
import { BackLink } from "../../../_components/BackLink";
import { EditMatchForm } from "../../../_components/EditMatchForm";

export const dynamic = "force-dynamic";

export default async function EditMatchPage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  await requireAdmin(`/matches/${gameId}`);

  const [players, games] = await Promise.all([listPlayers(), listGameRecords()]);
  const game = games.find((g) => g.gameId === gameId);
  if (!game) notFound();

  // MVP choices: everyone who played or scored in this game; every active
  // player only when the game has no roster at all.
  const inGame = new Set([
    ...game.homeRoster.map((s) => s.canonicalId),
    ...game.awayRoster.map((s) => s.canonicalId),
    ...game.goals.map((g) => g.scorerCanonicalId),
    ...(game.mvpCanonicalId ? [game.mvpCanonicalId] : []),
  ]);
  const mvpOptions = players
    .filter((p) => (inGame.size > 0 ? inGame.has(p.canonicalId) : p.status !== "deferred"))
    .map((p) => ({ canonicalId: p.canonicalId, name: rosterDisplayName(p) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <main>
      <BackLink fallbackHref={`/matches/${gameId}`} />
      <header className="screen-header-row">
        <h1 className="screen-header">Edit {formatMatchDateLabel(game.date)}</h1>
      </header>

      <section className="card">
        <p className="note">
          Rosters and goals can&rsquo;t be edited here — to fix those, delete the match (× on the
          match page) and re-import the report.
        </p>
        <EditMatchForm
          gameId={gameId}
          homeLabel={game.homeTeamLabel}
          awayLabel={game.awayTeamLabel}
          homeScore={game.homeScore}
          awayScore={game.awayScore}
          mvpCanonicalId={game.mvpCanonicalId}
          description={game.description ?? ""}
          mvpOptions={mvpOptions}
        />
      </section>
    </main>
  );
}
