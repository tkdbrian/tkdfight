import { cn } from "@/lib/utils";
import { useTournamentStore } from "@/store/tournament";
import { useSocket } from "@/hooks/useSocket";
import { CategoryTabs } from "@/components/CategoryTabs";
import {
  Trophy,
  Users,
  Swords,
  BarChart3,
  Settings,
  Tv,
  LayoutDashboard,
  ExternalLink,
  GitBranch,
  ListOrdered,
  History,
  HelpCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { startGlobalTour, continueTourIfPending } from "@/lib/tour";

type NavItem = { to: string; icon: typeof Users; label: string; short: string };

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Preparación",
    items: [
      { to: "/settings", icon: Settings, label: "Reglas", short: "Reglas" },
      { to: "/", icon: Users, label: "Competidores", short: "Compet." },
    ],
  },
  {
    label: "Torneo",
    items: [
      { to: "/fight", icon: Swords, label: "Combate", short: "Combate" },
      { to: "/bracket", icon: GitBranch, label: "Bracket", short: "Bracket" },
      { to: "/standings", icon: ListOrdered, label: "Clasificación", short: "Tabla" },
    ],
  },
  {
    label: "Análisis",
    items: [
      { to: "/results", icon: BarChart3, label: "Resultados", short: "Stats" },
      { to: "/history", icon: History, label: "Historial", short: "Hist." },
    ],
  },
];

export function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const phase = useTournamentStore((s) => s.phase);
  const categoryId = useTournamentStore((s) => s.config.id);
  const categoryRevision = useTournamentStore((s) => s.categoryRevision);
  const categoryOperationReason = useTournamentStore((s) => s.categoryOperationReason);
  const getCategoryEntries = useTournamentStore((s) => s.getCategoryEntries);
  const categoryName = useTournamentStore((s) => s.config.categoryName);
  const matchType = useTournamentStore((s) => s.config.matchType);
  const tournamentMode = useTournamentStore((s) => s.config.mode);
  const importedPending = useTournamentStore((s) =>
    s.fights.filter((f) => f.importedFrom && !f.completed).length
  );
  const { connected, stateReady, state: serverState } = useSocket();
  const ringAlias = serverState.ringAlias;
  const location = useLocation();
  const navigate = useNavigate();
  const visibleNavGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !(item.to === "/standings" && tournamentMode === "elimination")),
  }));
  const visibleNavItemsFlat = visibleNavGroups.flatMap((group) => group.items);
  const localEntries = getCategoryEntries();
  const recoveryLock = serverState.activeMatchLock ?? (
    serverState.match && !serverState.resultConfirmed
      ? {
          fightId: serverState.match.id,
          categoryId: serverState.categoryId ?? serverState.match.categoryId ?? null,
          tournamentId: serverState.tournamentId ?? 0,
          resultStatus: null,
        }
      : null
  );
  const recoveryDataMissing = !!recoveryLock && !localEntries.some((entry) =>
    entry.id === recoveryLock.categoryId && entry.fightIds.includes(recoveryLock.fightId)
  );

  const [externalOpen, setExternalOpen] = useState(() => {
    try { return localStorage.getItem("tkd-sidebar-external-open") === "1"; } catch { return false; }
  });
  const toggleExternal = () => {
    setExternalOpen((v) => {
      const next = !v;
      try { localStorage.setItem("tkd-sidebar-external-open", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  useEffect(() => {
    continueTourIfPending(navigate, location.pathname);
  }, [location.pathname, navigate]);

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar — visible md+ only */}
      <aside className="hidden md:flex w-56 shrink-0 border-r border-border flex-col">
        {/* Logo */}
        <div className="h-14 flex items-center gap-2 px-4 border-b border-border">
          <Trophy className="size-5 text-primary" />
          <span className="font-bold text-sm tracking-wide uppercase">TKD Fight</span>
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
        <nav className="flex-1 px-2 py-3 overflow-y-auto">
          {visibleNavGroups.map((group, gi) => (
            <div key={group.label}>
              {/* Separator + group label (not before the first group) */}
              {gi > 0 && <div className="border-t border-border mx-1 my-2" />}
              <p className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 select-none">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map(({ to, icon: Icon, label }) => {
                  const disabled =
                    (to === "/fight" || to === "/results" || to === "/bracket" || to === "/standings") &&
                    phase === "setup";
                  const displayLabel = to === "/fight" ? (matchType === "tul" ? "Formas" : "Combate") : label;
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
                      {displayLabel}
                      {to === "/fight" && importedPending > 0 && (
                        <span className="ml-auto text-[10px] font-bold bg-yellow-500 text-yellow-950 px-1.5 py-0.5 rounded-full animate-pulse min-w-[18px] text-center leading-none">
                          {importedPending}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}

          {/* External links — colapsable, oculto por defecto */}
          <div className="border-t border-border mx-1 my-2" />
          <button
            type="button"
            onClick={toggleExternal}
            className="w-full flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground select-none transition-colors"
          >
            {externalOpen
              ? <ChevronDown className="size-3" />
              : <ChevronRight className="size-3" />}
            <span>Pantallas externas</span>
          </button>
          {externalOpen && (
            <div className="space-y-0.5">
              <a
                href="/tv"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Tv className="size-5 shrink-0" />
                Pantalla TV
                <ExternalLink className="size-4 ml-auto opacity-50" />
              </a>
              <a
                href="/central"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <LayoutDashboard className="size-5 shrink-0" />
                Mesa Central
                <ExternalLink className="size-4 ml-auto opacity-50" />
              </a>
            </div>
          )}
        </nav>

        {/* Tour button */}
        <div className="px-2 pb-1">
          <button
            type="button"
            onClick={() => startGlobalTour(navigate, location.pathname)}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <HelpCircle className="size-5 shrink-0" />
            ¿Cómo funciona?
          </button>
        </div>

        {/* Phase indicator + branding */}
        <div className="px-4 py-3 border-t border-border space-y-2">
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
          <div className="text-[10px] text-muted-foreground/70 leading-tight">
            <div className="font-semibold text-primary/80 tracking-wide">BL System v{__APP_VERSION__}</div>
            <div>Creado por Master Brian Lipnjak</div>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile top header — hidden md+ */}
        <header className="md:hidden h-12 shrink-0 border-b border-border flex items-center gap-2 px-4">
          <Trophy className="size-4 text-primary" />
          <span className="font-bold text-sm tracking-wide uppercase">TKD Fight</span>
          {categoryName && (
            <span className="ml-2 text-[10px] text-muted-foreground truncate max-w-30">
              {categoryName}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => startGlobalTour(navigate, location.pathname)}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              aria-label="Cómo funciona"
            >
              <HelpCircle className="size-4" />
            </button>
            {ringAlias && (
              <span className="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                {ringAlias}
              </span>
            )}
          </div>
        </header>

        <CategoryTabs connected={connected} stateReady={stateReady} serverState={serverState} />

        {/* Page content */}
        <div
          id="category-panel"
          role="tabpanel"
          aria-labelledby={`category-tab-${categoryId}`}
          key={categoryId}
          className="relative flex-1 flex flex-col overflow-hidden"
        >
          {recoveryDataMissing ? (
            <div className="flex flex-1 items-center justify-center overflow-auto p-6">
              <div className="max-w-xl rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-center">
                <h1 className="text-lg font-bold text-destructive">Recuperación pendiente</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  El servidor conserva el combate {recoveryLock?.fightId ?? "sin identidad verificable"}, pero la llave local no contiene esa pelea. No se aplicó el resultado a otra categoría ni se descartó información.
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  No inicies otra categoría desde este tatami hasta recuperar o importar la llave correspondiente.
                </p>
              </div>
            </div>
          ) : children}
          {!recoveryDataMissing && categoryOperationReason && (
            <div role="status" className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 p-6 backdrop-blur-[1px]">
              <p className="max-w-sm rounded-md border border-border bg-card px-4 py-3 text-center text-sm font-medium shadow-lg">
                {categoryOperationReason}
              </p>
            </div>
          )}
        </div>

        {/* Mobile bottom navigation — hidden md+ */}
        <nav className="md:hidden shrink-0 border-t border-border bg-background flex items-stretch h-14">
          {visibleNavItemsFlat.map(({ to, icon: Icon, short }) => {
            const disabled =
              (to === "/fight" || to === "/results" || to === "/bracket" || to === "/standings") &&
              phase === "setup";
            const displayShort = to === "/fight" ? (matchType === "tul" ? "Formas" : "Combate") : short;
            return (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                aria-disabled={disabled}
                tabIndex={disabled ? -1 : undefined}
                className={({ isActive }) =>
                  cn(
                    "flex-1 flex flex-col items-center justify-center gap-0.5 text-center transition-colors relative",
                    isActive
                      ? "text-primary"
                      : "text-muted-foreground",
                    disabled && "pointer-events-none opacity-30"
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon className={cn("size-5 shrink-0", isActive && "stroke-[2.5]")} />
                    <span className="text-[9px] leading-none font-medium truncate w-full px-0.5 text-center">
                      {displayShort}
                    </span>
                    {to === "/fight" && importedPending > 0 && (
                      <span className="absolute top-1.5 right-[calc(50%-18px)] text-[8px] font-bold bg-yellow-500 text-yellow-950 px-1 py-0.5 rounded-full animate-pulse leading-none">
                        {importedPending}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>
      </main>
    </div>
  );
}
