import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  type CategoryPrimaryActionContext,
  getCategoryPrimaryAction,
} from "@/lib/category-lifecycle";
import { useCategoryInteractionBlocked } from "@/hooks/useCategoryInteractionBlocked";
import { useTournamentStore } from "@/store/tournament";

export function CategoryCombatAction(
  context: Omit<CategoryPrimaryActionContext, "snapshot">
): React.JSX.Element | null {
  const snapshot = useTournamentStore(
    useShallow((state) => ({
      phase: state.phase,
      config: state.config,
      competitors: state.competitors,
      fights: state.fights,
      groups: state.groups,
      currentFightIndex: state.currentFightIndex,
      bracketMatches: state.bracketMatches,
      bracketSeeds: state.bracketSeeds,
      setupStarted: state.setupStarted,
    }))
  );
  const blocked = useCategoryInteractionBlocked();
  const action = getCategoryPrimaryAction({ ...context, snapshot });
  const navigate = useNavigate();
  if (action.route !== "/fight" || !action.fightId) {
    return action.reason && action.kind === "continue" ? (
      <p role="status" className="text-sm text-muted-foreground">
        {action.reason}
      </p>
    ) : null;
  }
  return (
    <Button
      size="lg"
      disabled={blocked}
      onClick={() => {
        const latest = useTournamentStore.getState();
        if (latest.config.id !== snapshot.config.id) return;
        const index = latest.fights.findIndex((fight) => fight.id === action.fightId);
        if (index < 0) return;
        latest.setCurrentFightIndex(index);
        navigate("/fight", {
          state: {
            kind: "category-continue",
            categoryId: latest.config.id,
            fightId: action.fightId,
          },
        });
      }}
    >
      {action.label}
    </Button>
  );
}
