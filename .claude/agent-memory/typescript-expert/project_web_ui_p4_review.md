---
name: project-web-ui-p4-review
description: Findings from the P4 React/TS quality gate on web/ (Vite+React19+TS admin SPA for the FB-automation control plane)
metadata:
  type: project
---

The `web/` SPA (Vite 6 + React 19 + TS 5 strict) is high quality. Gate verdict 2026-06-12: production-quality, no blocking issues. `tsc -b --noEmit` exits 0; bundle 91KB gz. Zero `any`/`@ts-ignore`/non-null-abuse — only `as` is `document.activeElement as HTMLElement|null` (canonical). Types in `api/types.ts` verified accurate against `server/serializers.js` allowlist + `db/schema.sql` NOT NULL constraints (not guessed).

**Why:** Independent quality gate before P5 hardening. The team-lead wanted blocking-vs-clean determination.

**How to apply:** The two real (non-blocking) findings to revisit if touched again:
1. MEDIUM — `WorkerTelemetry` calls `useWorkerStatus()` independently and is mounted twice on the Overview route (AppShell top bar + OverviewScreen body), so two 5s pollers hit `/api/worker/status` concurrently (3 on Worker screen). Fix: lift worker status into a context/provider so one poller fans out. See `components/WorkerTelemetry.tsx:29`, `lib/useWorkerStatus.ts`.
2. LOW — `lib/useWorkerStatus.ts:115` derives `health` from `pendingUntil.current` (a ref) during render; ref mutation in `markPending()` doesn't trigger re-render, and the pending-window *expiry* only repaints on the next 5s poll. Works in practice (8s window > 5s poll) but is a render-purity smell. Also `ConfirmDialog` hardcodes `id="confirm-title"` instead of `useId()` — would collide if two dialogs ever mount.

The `key={…}` remount-to-reseed-form pattern (AccountEditorScreen:153, SettingsScreen:94) is used correctly to avoid fragile useEffect state-sync. No dirty-tracking / unsaved-changes guard on the editor forms — intentional-but-worth-noting UX gap.
