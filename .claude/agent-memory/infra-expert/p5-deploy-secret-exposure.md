---
name: p5-deploy-secret-exposure
description: P5 deploy review — live OpenAI key + FB password are in git HEAD history AND the unrotated key is still in working .env; gitignore only protects the current index, not history
metadata:
  type: project
---

P5 single-VPS pm2 deploy review (2026-06-12) found the only BLOCKING gap is secret exposure, not the pm2/healthcheck/runbook mechanics (those are sound).

Fact: `git show HEAD:config.json` and `HEAD:accounts.json` expose live plaintext secrets — OpenAI key `sk-proj-do0a1IG8jO...` (164 chars) and FB password `Rana@aba1`. The `.gitignore` correctly untracks the working-tree copies (so `git ls-files` returns nothing), but the secrets remain reachable in committed history back to "Initial commit". Verified the OpenAI key in the working `.env` is BYTE-IDENTICAL to the one in history — it was never rotated, so the exposed key is still the live one.

**Why:** RUNBOOK.md §14 frames git-history purge + key rotation as "user-gated, not part of routine deploy." That framing is correct for the *purge*, but the *rotation* of an already-public credential is an active-exposure remediation, not a deploy nicety — a deploy that ships the same live key is shipping a known-compromised credential.

**How to apply:** In any future deploy-readiness verdict for this repo, treat "rotate the exposed OpenAI key + FB password, THEN purge history" as a hard pre-deploy gate, separate from the deploy-artifact quality (which passed). Re-check whether the key still matches history before re-asserting the gap is closed — the fix is rotation at the OpenAI dashboard, not a code change. Related: [[p5-deploy-pm2-topology]].
