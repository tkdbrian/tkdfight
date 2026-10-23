import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { recoverCategoryDeletion } from "@/lib/category-deletion-controller";
import {
  type CategoryPrimaryActionContext,
  categoryRestartBlockedReason,
} from "@/lib/category-lifecycle";
import { categoryOperationDisplayMessage } from "@/lib/category-operation-errors";
import { useCategoryDeletionState } from "@/store/category-deletion-state";

export function CategoryDeletionRecovery(
  context: Pick<CategoryPrimaryActionContext, "connected" | "stateReady" | "serverState">
): React.JSX.Element | null {
  const { connected, stateReady } = context;
  const { pending, recoveryRequired, message } = useCategoryDeletionState(
    useShallow((state) => ({
      pending: state.pending,
      recoveryRequired: state.recoveryRequired,
      message: state.message,
    }))
  );
  useEffect(() => {
    if (connected && stateReady && useCategoryDeletionState.getState().recoveryRequired) {
      void recoverCategoryDeletion();
    }
  }, [connected, stateReady]);
  if (!pending && !recoveryRequired) return null;
  return (
    <section
      role="alert"
      className="shrink-0 space-y-2 border-b border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <p>
        <strong>Solo lectura · Eliminación pendiente de resolución.</strong>{" "}
        {categoryOperationDisplayMessage(message)}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending || Boolean(categoryRestartBlockedReason(context))}
        onClick={() => void recoverCategoryDeletion(true, context)}
      >
        {pending ? "Recuperando…" : "Recuperar eliminación"}
      </Button>
    </section>
  );
}
