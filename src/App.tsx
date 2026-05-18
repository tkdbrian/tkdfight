import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "@/layouts/AppLayout";
import { SetupPage } from "@/pages/SetupPage";
import { FightPage } from "@/pages/FightPage";
import { ResultsPage } from "@/pages/ResultsPage";
import { BracketPage } from "@/pages/BracketPage";
import { StandingsPage } from "@/pages/StandingsPage";
import { TVPage } from "@/pages/TVPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { CentralPage } from "@/pages/CentralPage";

export function App() {
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  );
}
