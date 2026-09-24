// OperatorApp — router + auth gate. If not authenticated, render the login
// screen (the app is unreachable without a session token per spec §7.6).

import { Routes, Route } from "react-router-dom";
import { useSession } from "@/shared/session";
import { LoginScreen } from "./LoginScreen";
import { AppShell } from "./AppShell";
import { JobBoard } from "./routes/JobBoard";
import { JobRoom } from "./routes/JobRoom";
import { IntakeBay } from "./routes/IntakeBay";
import { PartsManifest } from "./routes/PartsManifest";
import { BudgetRoom } from "./routes/BudgetRoom";
import { SourcingRoom } from "./routes/SourcingRoom";
import { ModelShop } from "./routes/ModelShop";
import { EngineRoom } from "./routes/EngineRoom";
import { ShopInsights } from "./routes/ShopInsights";
import { KnowledgeBase } from "./routes/KnowledgeBase";
import { NotFound } from "./routes/NotFound";

export function OperatorApp() {
  const { isAuthenticated } = useSession();

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="*" element={<LoginScreen />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<JobBoard />} />
        <Route path="projects/:projectId" element={<JobRoom />} />
        <Route path="projects/:projectId/intake" element={<IntakeBay />} />
        <Route path="projects/:projectId/manifest" element={<PartsManifest />} />
        <Route path="projects/:projectId/budget" element={<BudgetRoom />} />
        <Route path="projects/:projectId/sourcing" element={<SourcingRoom />} />
        <Route path="projects/:projectId/model" element={<ModelShop />} />
        <Route path="projects/:projectId/system" element={<EngineRoom />} />
        <Route path="engine-room" element={<EngineRoom />} />
        <Route path="insights" element={<ShopInsights />} />
        <Route path="knowledge" element={<KnowledgeBase />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
