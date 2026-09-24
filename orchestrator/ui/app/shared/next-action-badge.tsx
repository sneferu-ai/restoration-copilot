// NextActionBadge (§4.8 inventory, §6.0 layer 1) — the one deterministic CTA
// per project. Generic on the board; count-aware inside JobRoom.

import { Link } from "react-router-dom";
import { useNextAction } from "./hooks";
import type { RestorationProject } from "./types";

export function NextActionBadge({
  project,
  details,
  link = true,
}: {
  project: RestorationProject;
  details?: { openReviews?: number; sourcingCoverage?: number | null };
  link?: boolean;
}) {
  const action = useNextAction(project, details);
  if (!action) return null;
  const inner = (
    <>
      <span className="font-semibold">{action.label}</span>
      <span className="text-xs text-accent-ink/70">{action.reason}</span>
    </>
  );
  const cls =
    "inline-flex flex-col gap-0.5 rounded-md bg-accent px-3 py-1.5 text-left text-sm text-accent-ink transition-colors duration-150 hover:bg-accent-hover active:bg-accent-pressed";
  if (link && action.to) {
    return (
      <Link to={action.to.replace(/^#/, "")} className={cls} data-testid="next-action">
        {inner}
      </Link>
    );
  }
  return (
    <span className={cls} data-testid="next-action" title={action.reason}>
      {inner}
    </span>
  );
}
