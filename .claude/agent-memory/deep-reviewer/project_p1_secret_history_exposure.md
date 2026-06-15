---
name: p1-secret-history-exposure
description: Phase 1 moved secrets out of the working tree but live OpenAI key + FB passwords remain committed in git history (HEAD 72ff428 and ancestors)
metadata:
  type: project
---

Phase 1 secrets remediation is INCOMPLETE at the history layer. The crypto.js AES-256-GCM design is sound (verified empirically: random 12-byte IV per op, 16-byte GCM tag, tamper+wrong-key+short-IV all rejected, no key/plaintext leakage in error messages). But:

- **Live OpenAI key** `sk-proj-do0a1IG8...AIrVEUhqgA` is committed in `config.json` across the ENTIRE history including current HEAD `72ff428` (also cbfa5ed, d6fae1c, cfc70eb, ceda21cd). Working-tree config.json STILL contains it on line 14 (gitignored now, so it won't be re-committed, but the live value is on disk and in history).
- **FB account passwords** committed in `accounts.json` history: `Asmaa@aba1` (8ee95f4→d6fae1c, and HEAD 72ff428) and `Rana@aba1` (cfc70eb, ceda21cd). HEAD's accounts.json was a SAFE example variant in the worktree but a REAL password (`Asmaa@aba1`) is the committed blob at 72ff428.

**Why:** ai.js/vision.js were rewired to read `process.env.OPENAI_API_KEY` (no config.json fallback — confirmed), and .gitignore now excludes config.json/accounts.json/.env/db/*.db/sessions/state. That stops FUTURE leakage but does nothing about the existing history.

**How to apply:** Any "secrets are now safe" claim for this repo is FALSE until (1) both exposed credentials are ROTATED (OpenAI key revoked, both FB passwords changed), and (2) git history is purged (git filter-repo / BFG) or the repo is re-initialized. Rotation is the real fix; history purge is cleanup. Do NOT greenlight P2/P3 as "built on a secure P1" without this. Threat model = "repo could be copied" — history travels with every clone.

Related: crypto round-trip is trustworthy, so the path forward (encrypt creds into SQLite, key in .env only) is architecturally OK once the leaked live secrets are rotated.
