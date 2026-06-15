/*
 * App.tsx — routing + auth gating.
 *
 * Route structure (React Router v7 nested layout routes):
 *   /login                        → LoginGate (anonymous; bounces if authed)
 *   <RequireAuth>  (guard layout) → renders <Outlet/> only when authenticated
 *     <AppShell>   (chrome layout)→ sidebar + top bar + <Outlet/>
 *       index → Overview
 *       accounts, accounts/new, accounts/:id, settings, worker, activity
 *
 * A 'loading' status (initial /me bootstrap) shows a centered loader so we never
 * flash the login form for a user who actually has a valid session.
 */
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
} from 'react-router-dom';
import { useAuth } from './lib/auth';
import { WorkerStatusProvider } from './lib/useWorkerStatus';
import { AppShell } from './components/AppShell';
import { LoadingState } from './components/ui';
import { LoginScreen } from './screens/LoginScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { AccountsScreen } from './screens/AccountsScreen';
import { AccountEditorScreen } from './screens/AccountEditorScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { WorkerScreen } from './screens/WorkerScreen';
import { ActivityScreen } from './screens/ActivityScreen';

/*
 * Data router (createBrowserRouter) — REQUIRED for React Router's useBlocker,
 * which the unsaved-changes guard (lib/useUnsavedGuard) depends on. The component
 * <BrowserRouter> API does NOT expose a data router, so useBlocker throws at
 * runtime under it (the editor/settings screens that mount the guard crash). The
 * route tree is unchanged; only the router construction differs. Built once at
 * module scope (LoginGate/RequireAuth are hoisted function declarations).
 */
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route>
      <Route path="/login" element={<LoginGate />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<OverviewScreen />} />
          <Route path="accounts" element={<AccountsScreen />} />
          <Route path="accounts/new" element={<AccountEditorScreen mode="create" />} />
          <Route path="accounts/:id" element={<AccountEditorScreen mode="edit" />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="worker" element={<WorkerScreen />} />
          <Route path="activity" element={<ActivityScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Route>
  )
);

export function App() {
  return <RouterProvider router={router} />;
}

/** Render login when anonymous; bounce to dashboard when already authenticated. */
function LoginGate() {
  const { status } = useAuth();
  if (status === 'loading') return <CenteredLoader />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <LoginScreen />;
}

/**
 * Guard layout for the authenticated section. Mounts the single
 * WorkerStatusProvider HERE (authenticated subtree only) so there is exactly one
 * /api/worker/status poller for the whole app — shared by the top-bar telemetry,
 * the Overview, and the Worker screen — and it never polls on the login screen.
 */
function RequireAuth() {
  const { status } = useAuth();
  if (status === 'loading') return <CenteredLoader />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <WorkerStatusProvider>
      <Outlet />
    </WorkerStatusProvider>
  );
}

function CenteredLoader() {
  return (
    <div className="boot-screen">
      <LoadingState label="Connecting to the control plane…" />
    </div>
  );
}
