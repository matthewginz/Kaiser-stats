// Usage: npx tsx --env-file=.env.local scripts/dossier-data.ts <canonicalId> > out.json
// Dumps the facts behind a player's scouting dossier (see src/lib/player-dossiers.ts): standings by
// season, reported-game production by half-season, captain record, draft value vs a league-wide model,
// teammates, best games, and report quotes. Read-only.
import { aggregateStandings, filterSeasonStandingRowsByYear } from "../src/lib/stats-engine/aggregate";
import { listGameRecords, listPlayers, listSeasonStandingRows } from "../src/lib/stats-engine/data";
import type { GameRecord } from "../src/lib/stats-engine/types";

const id = process.argv[2]!;
const half = (d: string) => `${d.slice(0, 4)} H${Number(d.slice(5, 7)) <= 6 ? 1 : 2}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

(async () => {
  const [players, allRows, games] = await Promise.all([listPlayers(), listSeasonStandingRows(), listGameRecords()]);
  const me = players.find((p) => p.canonicalId === id)!;
  const name = (cid: string | null) => players.find((p) => p.canonicalId === cid)?.displayName ?? cid;

  const seasons = ["2022", "2023", "2024", "2025", "2026"].map((y) => {
    const { players: t } = aggregateStandings(filterSeasonStandingRowsByYear(allRows, y), players, "merged");
    const s = t.find((p) => p.canonicalId === id);
    return s && { year: y, gp: s.games, w: s.wins, d: s.ties, l: s.losses, goals: s.goals, pm: s.plusMinus };
  }).filter(Boolean);

  const reported = games.filter((g) => g.homeScore !== null).sort((a, b) => a.date.localeCompare(b.date));
  const side = (g: GameRecord, cid: string) =>
    g.homeRoster.some((s) => s.canonicalId === cid) ? "home" : g.awayRoster.some((s) => s.canonicalId === cid) ? "away" : null;

  // league-wide per-player reported production, for the draft-value model + ranks
  const league = new Map<string, { gp: number; g: number; a: number; picks: number[] }>();
  for (const g of reported) for (const team of ["home", "away"] as const) {
    const roster = team === "home" ? g.homeRoster : g.awayRoster;
    roster.forEach((s) => {
      const e = league.get(s.canonicalId) ?? { gp: 0, g: 0, a: 0, picks: [] };
      e.gp++;
      e.g += g.goals.filter((x) => x.scorerCanonicalId === s.canonicalId).length;
      e.a += g.goals.filter((x) => x.assistCanonicalId === s.canonicalId).length;
      if (s.pickNumber !== null) e.picks.push(s.pickNumber);
      league.set(s.canonicalId, e);
    });
  }
  const pts = [...league.values()].filter((e) => e.gp >= 8 && e.picks.length >= 5)
    .map((e) => ({ x: e.picks.reduce((a, b) => a + b, 0) / e.picks.length, y: (e.g + e.a) / e.gp }));
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length, my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const slope = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const model = { intercept: r2(my - slope * mx), slope: Math.round(slope * 1000) / 1000, n: pts.length };
  const rated = [...league.entries()].filter(([, e]) => e.gp >= 10);
  const rank = (f: (e: { gp: number; g: number; a: number }) => number) =>
    `${1 + rated.filter(([, e]) => f(e) > f(league.get(id)!)).length} of ${rated.length}`;

  const byHalf = new Map<string, { gp: number; g: number; a: number; picks: number[]; w: number; d: number; l: number }>();
  const capt = { w: 0, d: 0, l: 0 }, sizes: Record<string, { gp: number; g: number }> = {};
  interface LogRow { date: string; score: string; res: string; goals: number; assists: number; pick: number | null; capt: boolean; mvp: boolean; players: number }
  const mates = new Map<string, { gp: number; w: number }>(), log: LogRow[] = [];
  const quotes: { date: string; res: string; goals: number; assists: number; q: string }[] = [];
  let mvp = 0, scoredIn = 0;
  const words = [me.displayName, me.rosterName, ...me.aliases].filter(Boolean).map((s) => s!.toLowerCase());

  for (const g of reported) {
    const t = side(g, id);
    if (!t) continue;
    const roster = t === "home" ? g.homeRoster : g.awayRoster;
    const [mine, theirs] = t === "home" ? [g.homeScore!, g.awayScore!] : [g.awayScore!, g.homeScore!];
    const res = mine > theirs ? "W" : mine < theirs ? "L" : "D";
    const goals = g.goals.filter((x) => x.scorerCanonicalId === id).length;
    const assists = g.goals.filter((x) => x.assistCanonicalId === id).length;
    const pick = roster.find((s) => s.canonicalId === id)!.pickNumber;
    const isCapt = roster[0]!.canonicalId === id;
    const h = byHalf.get(half(g.date)) ?? { gp: 0, g: 0, a: 0, picks: [], w: 0, d: 0, l: 0 };
    h.gp++; h.g += goals; h.a += assists; if (pick !== null) h.picks.push(pick);
    h[res === "W" ? "w" : res === "D" ? "d" : "l"]++;
    byHalf.set(half(g.date), h);
    if (isCapt) capt[res === "W" ? "w" : res === "D" ? "d" : "l"]++;
    if (g.mvpCanonicalId === id) mvp++;
    if (goals) scoredIn++;
    const n = g.homeRoster.length + g.awayRoster.length, k = n <= 18 ? "≤18" : n <= 21 ? "19-21" : "22+";
    sizes[k] = { gp: (sizes[k]?.gp ?? 0) + 1, g: (sizes[k]?.g ?? 0) + goals };
    for (const s of roster) if (s.canonicalId !== id) {
      const m = mates.get(s.canonicalId) ?? { gp: 0, w: 0 }; m.gp++; if (res === "W") m.w++; mates.set(s.canonicalId, m);
    }
    log.push({ date: g.date, score: `${mine}-${theirs}`, res, goals, assists, pick, capt: isCapt, mvp: g.mvpCanonicalId === id, players: n });
    const qs = g.notableMentions.filter((m) => m.canonicalId === id).map((m) => m.quote);
    for (const sent of (g.description ?? "").split(/(?<=[.!?])\s+/))
      if (words.some((w) => sent.toLowerCase().includes(w))) qs.push(sent.trim());
    for (const q of new Set(qs)) quotes.push({ date: g.date, res: `${res} ${mine}-${theirs}`, goals, assists, q: q.slice(0, 400) });
  }

  const tot = log.reduce((a, x) => ({ gp: a.gp + 1, g: a.g + x.goals, a: a.a + x.assists, w: a.w + (x.res === "W" ? 1 : 0), d: a.d + (x.res === "D" ? 1 : 0) }), { gp: 0, g: 0, a: 0, w: 0, d: 0 });
  const allPicks = log.map((x) => x.pick).filter((p) => p !== null) as number[];
  const avgPick = allPicks.length ? r2(allPicks.reduce((a, b) => a + b, 0) / allPicks.length) : null;
  console.log(JSON.stringify({
    player: { id, displayName: me.displayName, rosterName: me.rosterName, aliases: me.aliases, positions: me.positions, leagues: me.leagues, status: me.status },
    seasons,
    reported: { ...tot, l: tot.gp - tot.w - tot.d, gaPerGame: r2((tot.g + tot.a) / tot.gp), goalsPerGame: r2(tot.g / tot.gp), mvp, scoredInPct: Math.round((100 * scoredIn) / tot.gp), avgPick, draftedGames: allPicks.length, captain: capt, first: log[0]?.date, last: log.at(-1)?.date, totalReportedLeagueGames: reported.length },
    ranks: { goalsPerGame: rank((e) => e.g / e.gp), assistsPerGame: rank((e) => e.a / e.gp), gaPerGame: rank((e) => (e.g + e.a) / e.gp) },
    model: { ...model, expectedAtAvgPick: avgPick === null ? null : r2(model.intercept + model.slope * avgPick) },
    byHalf: [...byHalf.entries()].map(([k, v]) => ({ period: k, gp: v.gp, g: v.g, a: v.a, w: v.w, d: v.d, l: v.l, adp: v.picks.length ? r2(v.picks.reduce((a, b) => a + b, 0) / v.picks.length) : null })),
    rosterSize: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, { gp: v.gp, goalsPerGame: r2(v.g / v.gp) }])),
    teammates: [...mates.entries()].filter(([, m]) => m.gp >= 10).map(([c, m]) => ({ name: name(c), gp: m.gp, winPct: Math.round((100 * m.w) / m.gp) })).sort((a, b) => b.winPct - a.winPct),
    bestGames: [...log].sort((a, b) => b.goals * 2 + b.assists - (a.goals * 2 + a.assists)).slice(0, 6),
    quotes,
  }, null, 1));
})();
