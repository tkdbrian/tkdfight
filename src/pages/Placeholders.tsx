import { Swords, BarChart3, Monitor, Settings } from "lucide-react";

function PlaceholderPage({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
      <Icon className="size-16 opacity-20" />
      <p className="text-lg font-medium">{title}</p>
      <p className="text-sm">En construcción…</p>
    </div>
  );
}

export const FightPage = () => <PlaceholderPage icon={Swords} title="Combate" />;
export const ResultsPage = () => <PlaceholderPage icon={BarChart3} title="Resultados" />;
export const TVPage = () => <PlaceholderPage icon={Monitor} title="Pantalla TV" />;
export const SettingsPage = () => <PlaceholderPage icon={Settings} title="Configuración" />;
