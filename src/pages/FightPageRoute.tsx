import { Link, useLocation } from "react-router-dom";
import { getFightPageEntry } from "@/lib/fight-navigation";
import { FightPage } from "@/pages/FightPage";
import { useTournamentStore } from "@/store/tournament";

export function FightPageRoute(): React.JSX.Element {
  const location = useLocation();
  const categoryId = useTournamentStore((state) => state.config.id);
  const mode = useTournamentStore((state) => state.config.mode);
  const fights = useTournamentStore((state) => state.fights);
  if (getFightPageEntry(location.state, categoryId, fights).mode === "invalid") {
    return (
      <section className="p-6 space-y-3" aria-label="Continuación no disponible">
        <h1>No se encontró el combate de esta continuación</h1>
        <p>La categoría o su lista cambió. Se conservaron los datos; volvé a elegir un combate.</p>
        <Link to={mode === "elimination" ? "/bracket" : "/standings"}>Revisar categoría</Link>
        <Link to="/">Volver a Competidores</Link>
      </section>
    );
  }
  return <FightPage navigationIntent={location.state} navigationEntryKey={location.key} />;
}
