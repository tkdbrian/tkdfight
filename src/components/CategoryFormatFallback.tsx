import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { TournamentMode } from "@/store/tournament";

/** No automatic redirect: restoring a selected snapshot must not overwrite its saved route. */
export function CategoryFormatFallback({ mode, setup }: Readonly<{
  mode: TournamentMode;
  setup: boolean;
}>): React.JSX.Element {
  const elimination = mode === "elimination";
  const target = setup ? "/" : elimination ? "/bracket" : "/standings";
  const action = setup ? "Ir a Competidores" : elimination ? "Ver bracket" : "Ver clasificación";
  return (
    <div className="flex-1 p-6 flex flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <p>{elimination
        ? "Esta categoría usa eliminación directa; su seguimiento está en el bracket."
        : "Esta categoría usa Round Robin; su seguimiento está en la clasificación."}</p>
      {setup && <p className="text-sm">Primero completá la preparación de sus competidores.</p>}
      <Button variant="outline" asChild>
        <Link to={target}>{action}</Link>
      </Button>
    </div>
  );
}
