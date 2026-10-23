import type * as React from "react";
import { conservePrincipalTournamentCopy, hasPendingTournamentCommit, recoverTournamentAuthorities, useTournamentPersistenceState } from "@/lib/tournament-persistence";
import { useTournamentStore } from "@/store/tournament";
import { Button } from "@/components/ui/button";

export function TournamentPersistenceRecovery(): React.JSX.Element | null {
  const blocked = useTournamentPersistenceState((state) => state.blocked);
  const message = useTournamentPersistenceState((state) => state.message);
  const conflict = useTournamentPersistenceState((state) => state.conflict);
  if (!blocked) return null;
  return <section role="alert" className="border border-destructive bg-background p-3 text-sm shrink-0">
    <p className="font-bold">Guardado pendiente: el torneo está en modo de solo lectura.</p>
    <p>{message}</p>
    <p>El reloj del tatami no se detiene. No confirmes resultados desde otra ventana.</p>
    {conflict && <><p>{conflict.summary}</p><Button type="button" className="mt-2 mr-2" onClick={() => {
      if (window.confirm(`${conflict.summary} Se conservará la copia principal de esta categoría. Las demás categorías no se modificarán. ¿Confirmar?`) && conservePrincipalTournamentCopy())
        void useTournamentStore.persist.rehydrate();
    }}>Conservar copia principal</Button></>}
    <Button type="button" className="mt-2" onClick={() => {
      const pending = hasPendingTournamentCommit();
      if (recoverTournamentAuthorities() && (pending || useTournamentStore.getState().saveCategorySnapshot()))
        void useTournamentStore.persist.rehydrate();
    }}>Reintentar guardado</Button>
  </section>;
}
