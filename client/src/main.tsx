import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { api } from "./api";
import { Projects } from "./routes/Projects";
import { ProjectBoard } from "./routes/ProjectBoard";
import { RolesEditor } from "./routes/RolesEditor";
import { TaskDetail } from "./routes/TaskDetail";
import "./styles.css";

function SchedulerToggle() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["scheduler"], queryFn: api.scheduler, refetchInterval: 5000 });
  const start = useMutation({ mutationFn: api.startScheduler, onSuccess: () => qc.invalidateQueries({ queryKey: ["scheduler"] }) });
  const stop = useMutation({ mutationFn: api.stopScheduler, onSuccess: () => qc.invalidateQueries({ queryKey: ["scheduler"] }) });
  const running = data?.running ?? false;
  return (
    <div className="row">
      <span className={`pill ${running ? "ok" : "dim"}`}>{running ? "● running" : "○ stopped"}</span>
      {running ? (
        <button className="small" onClick={() => stop.mutate()}>Stop loop</button>
      ) : (
        <button className="small primary" onClick={() => start.mutate()}>Start loop</button>
      )}
    </div>
  );
}

function Root() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>◆ ORCHESTRA</h1>
        <nav>
          <Link to="/">Projects</Link>
        </nav>
        <div className="spacer" />
        <SchedulerToggle />
      </header>
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Root });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Projects });
const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId", component: ProjectBoard });
const rolesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId/roles", component: RolesEditor });
const taskRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tasks/$taskId", component: TaskDetail });

const routeTree = rootRoute.addChildren([indexRoute, boardRoute, rolesRoute, taskRoute]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
