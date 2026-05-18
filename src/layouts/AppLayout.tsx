import { cn } from "@/lib/utils";
import { useTournamentStore } from "@/store/tournament";
import { useSocket } from "@/hooks/useSocket";
import {
  Trophy,
  Users,
  Swords,
  BarChart3,
  Settings,
  Monitor,
  ExternalLink,
  GitBranch,
  ListOrdered,
} from "lucide-react";
import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", icon: Users, label: "Competidores", tv: false },
  { to: "/fight", icon: Swords, label: "Combate", tv: false },
  { to: "/bracket", icon: GitBranch, label: "Bracket", tv: false },
  { to: "/standings", icon: ListOrdered, label: "Clasificación", tv: false },
  { to: "/results", icon: BarChart3, label: "Resultados", tv: false },
  { to: "/settings", icon: Settings, label: "Configuración", tv: false },
];

export function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const phase = useTournamentStore((s) => s.phase);
  const categoryName = useTournamentStore((s) => s.config.categoryName);
  const importedPending = useTournamentStore((s) =>
    s.fights.filter((f) => f.importedFrom && !f.completed).length
  );
  const { state: serverState } = useSocket();
  const ringAlias = serverState.ringAlias;

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-border flex flex-col">
        {/* Logo */}
        <div className="h-14 flex items-center gap-2 px-4 border-b border-border">
          <Trophy className="size-5 text-primary" />
          <span className="font-bold text-sm tracking-wide uppercase">TKD System</span>
          {ringAlias && (
            <span className="ml-auto text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
              {ringAlias}
            </span>
          )}
        </div>

        {/* Category badge */}
        {categoryName && (
          <div className="mx-3 mt-3 px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground text-xs font-medium truncate">
            {categoryName}
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => {
            const disabled =
              (to === "/fight" || to === "/results" || to === "/bracket" || to === "/standings") &&
              phase === "setup";
            return (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                aria-disabled={disabled}
                tabIndex={disabled ? -1 : undefined}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    disabled && "pointer-events-none opacity-40"
                  )
                }
              >
                <Icon className="size-5 shrink-0" />
                {label}
                {to === "/fight" && importedPending > 0 && (
                  <span className="ml-auto text-[10px] font-bold bg-yellow-500 text-yellow-950 px-1.5 py-0.5 rounded-full animate-pulse min-w-[18px] text-center leading-none">
                    {importedPending}
                  </span>
                )}
              </NavLink>
            );
          })}

          {/* TV link — opens in new tab */}
          <a
            href="/tv"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Monitor className="size-5 shrink-0" />
            Pantalla TV
            <ExternalLink className="size-4 ml-auto opacity-50" />
          </a>

          {/* Central link — opens in new tab */}
          <a
            href="/central"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Monitor className="size-5 shrink-0" />
            Mesa Central
            <ExternalLink className="size-4 ml-auto opacity-50" />
          </a>
        </nav>

        {/* Phase indicator */}
        <div className="px-4 py-3 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                "size-2 rounded-full",
                phase === "setup" && "bg-yellow-500",
                phase === "fighting" && "bg-green-500 animate-pulse",
                phase === "results" && "bg-blue-500"
              )}
            />
            <span className="capitalize">{phase}</span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
