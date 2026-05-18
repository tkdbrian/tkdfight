import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "@/layouts/AppLayout";
import { SetupPage } from "@/pages/SetupPage";

const FightPage = lazy(() => import("@/pages/FightPage").then((m) => ({ default: m.FightPage })));
const ResultsPage = lazy(() => import("@/pages/ResultsPage").then((m) => ({ default: m.ResultsPage })));
const BracketPage = lazy(() => import("@/pages/BracketPage").then((m) => ({ default: m.BracketPage })));
const StandingsPage = lazy(() => import("@/pages/StandingsPage").then((m) => ({ default: m.StandingsPage })));
const TVPage = lazy(() => import("@/pages/TVPage").then((m) => ({ default: m.TVPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const CentralPage = lazy(() => import("@/pages/CentralPage").then((m) => ({ default: m.CentralPage })));

function RouteFallback() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-slate-950 text-slate-400">
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-slate-300" />
        <span className="text-sm">Cargando…</span>
      </div>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Full-screen sin sidebar */}
          <Route path="/tv" element={<TVPage />} />
          <Route path="/central" element={<CentralPage />} />

          {/* App con sidebar */}
          <Route
            path="/*"
            element={
              <AppLayout>
                <Routes>
                  <Route path="/" element={<SetupPage />} />
                  <Route path="/fight" element={<FightPage />} />
                  <Route path="/bracket" element={<BracketPage />} />
                  <Route path="/standings" element={<StandingsPage />} />
                  <Route path="/results" element={<ResultsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </AppLayout>
            }
          />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
