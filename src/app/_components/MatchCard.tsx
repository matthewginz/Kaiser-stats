import { formatMatchDateLabel, formatScoreLine, truncate } from "@/lib/format";
import { MvpBadge } from "./MvpBadge";

const DESCRIPTION_TRUNCATE_LENGTH = 140;

/**
 * Renders its own inner link to the match (rather than being wrapped in an
 * outer <a> by the caller, the way ScheduledGameCard/matchday still is) so
 * the MVP name can be its own separate link to that player's profile — a
 * nested <a> inside an <a> is invalid HTML and gets silently un-nested by
 * the parser, breaking the outer click target (see the matchday-card-wrapper
 * CSS comment for the sibling-not-nested pattern this follows instead).
 */
export function MatchCard({
  gameId,
  date,
  homeScore,
  awayScore,
  description,
  mvpName,
  mvpHref,
}: {
  gameId: string;
  date: string;
  homeScore: number | null;
  awayScore: number | null;
  description?: string;
  mvpName?: string;
  mvpHref?: string;
}) {
  return (
    <div className="match-card" data-tour-id="match-card">
      <a href={`/matches/${gameId}`} className="match-card-inner-link">
        <div className="match-card-top">
          <span className="match-card-date">{formatMatchDateLabel(date)}</span>
          <span className="match-card-score">{formatScoreLine(homeScore, awayScore)}</span>
        </div>
        {description && (
          <p className="match-card-desc">{truncate(description, DESCRIPTION_TRUNCATE_LENGTH)}</p>
        )}
      </a>
      {mvpName &&
        (mvpHref ? (
          <a href={mvpHref} className="match-card-mvp-link">
            <MvpBadge name={mvpName} />
          </a>
        ) : (
          <MvpBadge name={mvpName} />
        ))}
    </div>
  );
}
