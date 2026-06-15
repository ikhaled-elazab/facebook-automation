# frontend-platform-engineer — Memory Index

- [P4 web UI architecture](project_p4_web_ui.md) — web/ Vite+React+TS SPA served same-origin by Express; nested package, dist gitignored, verify-with-inline-env pattern
- [CSP reality + API contract](reference_csp_and_api_contract.md) — helmet merges defaults (style/img/font looser than source); snake_case, CSRF re-fetch after login, has_password booleans, worker status shape, feed cursor pagination
- [v2 branch contract](reference_v2_branch_contract.md) — account ENVELOPE + N Branches split; branch shape, nested routes, branch_count badge, and the inferred fields to confirm vs elite-engineer's serializer at the ts-expert gate
- [Login control contract](reference_login_control_contract.md) — per-account login UI (Model A creds + 2FA relay); LoginStatus enum, 3 endpoints, 409=already-running, open reconciliation points vs server/routes/login-control.js
