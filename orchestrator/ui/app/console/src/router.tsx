// Console router — hash-based (D1): the server only ever sees /restoration-ui.

import { createHashRouter, Navigate } from "react-router-dom";
import { ConsoleShell } from "./shell/ConsoleShell";
import { LoginRoute } from "./shell/LoginRoute";
import { JobBoard } from "./panels/JobBoard";
import { IntakeBay } from "./panels/IntakeBay";
import { JobRoom } from "./panels/JobRoom";
import { ShopInsights } from "./panels/ShopInsights";

export const router = createHashRouter([
  { path: "/login", element: <LoginRoute /> },
  {
    path: "/",
    element: <ConsoleShell />,
    children: [
      { index: true, element: <Navigate to="/jobs" replace /> },
      { path: "jobs", element: <JobBoard /> },
      { path: "jobs/new", element: <IntakeBay mode="create" /> },
      { path: "jobs/:projectId", element: <JobRoom /> },
      { path: "jobs/:projectId/:tab", element: <JobRoom /> },
      { path: "insights", element: <ShopInsights /> },
      { path: "*", element: <Navigate to="/jobs" replace /> },
    ],
  },
]);
