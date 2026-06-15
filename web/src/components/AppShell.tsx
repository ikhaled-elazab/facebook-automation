/*
 * AppShell.tsx — the authenticated layout: sidebar nav + sticky top bar + outlet.
 *
 * The top bar shows the live worker telemetry (the signature element) on every
 * screen, and the page heading. Nav uses semantic <nav> + NavLink active state,
 * is keyboard reachable, and collapses to an icon strip on narrow viewports.
 */
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { Button } from './ui';
import { WorkerTelemetry } from './WorkerTelemetry';
import {
  IconDashboard,
  IconAccounts,
  IconSettings,
  IconWorker,
  IconActivity,
  IconLogout,
} from './icons';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: <IconDashboard size={18} />, end: true },
  { to: '/accounts', label: 'Accounts', icon: <IconAccounts size={18} /> },
  { to: '/settings', label: 'Settings', icon: <IconSettings size={18} /> },
  { to: '/worker', label: 'Worker', icon: <IconWorker size={18} /> },
  { to: '/activity', label: 'Activity', icon: <IconActivity size={18} /> },
];

const HEADINGS: Record<string, { title: string; subtitle: string }> = {
  '/': { title: 'Overview', subtitle: 'Fleet health and worker status at a glance' },
  '/accounts': { title: 'Accounts', subtitle: 'Manage the automation accounts and their content' },
  '/settings': { title: 'Settings', subtitle: 'Global pacing, safety, and AI configuration' },
  '/worker': { title: 'Worker', subtitle: 'Start, stop, and monitor the automation worker' },
  '/activity': { title: 'Activity', subtitle: 'Recent actions across all accounts' },
};

export function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();

  // Resolve the heading: exact match, else the matching section prefix.
  const heading =
    HEADINGS[location.pathname] ??
    HEADINGS[
      Object.keys(HEADINGS).find((k) => k !== '/' && location.pathname.startsWith(k)) ?? '/'
    ];

  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="sidebar__mark" aria-hidden="true">
            FB
          </div>
          <div className="sidebar__title">
            <strong>Control</strong>
            <span>Console</span>
          </div>
        </div>

        <nav className="nav" aria-label="Primary">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav__link${isActive ? ' is-active' : ''}`}
            >
              <span className="nav__icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="nav__spacer" />

        <div className="sidebar__foot">
          <div className="sidebar__user">
            <span className="muted">Signed in as</span>
            <span className="mono truncate">{user ?? '—'}</span>
          </div>
          <Button variant="ghost" size="sm" block onClick={() => void logout()}>
            <IconLogout size={16} /> Sign out
          </Button>
        </div>
      </aside>

      <div className="main">
        <header className="main__bar">
          <div className="main__heading">
            <h1>{heading.title}</h1>
            <p>{heading.subtitle}</p>
          </div>
          <div className="main__bar-actions">
            <WorkerTelemetry compact />
          </div>
        </header>

        <main id="main" className="main__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
