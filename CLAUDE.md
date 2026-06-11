# CLAUDE.md

Guidance for Claude Code when working in this repository.

## CTO-LED 32-AGENT TEAM — LEAN ROUTING

This project has a 33-agent engineering team in `agents/` (31 specialists + `evidence-validator` + `challenger`), led by a `cto` agent. Full protocol detail (NEXUS syscalls, Shadow Mind, lifecycle, full dispatch tables, trust ledger) lives in **`docs/team/PROTOCOL_REFERENCE.md`** — read it on demand, not every turn.

### COST DISCIPLINE FIRST (BINDING)

Token cost is real: `cto.md` ≈ 23K tokens/dispatch, each specialist ≈ 15–18K, and auto-dispatched validators/challengers multiply that. **Default to the cheapest path that fits.** Escalation is cheap; over-provisioning is not.

- **Do trivial work directly on the main thread — do NOT dispatch an agent for it.** This includes: reads under ~5 files, single-file edits with known paths, git status/log, quick factual questions, one-line fixes, and routing.
- **Dispatch an agent only when the task genuinely needs that specialist's depth** (real implementation, multi-file review, domain expertise, strategic decision).
- **Dispatch `cto` only for genuinely strategic / cross-domain / high-risk work** — not as a default front door.
- When unsure whether a task needs the team at all: **do it directly first.** Re-dispatching upward is cheaper than running the full gauntlet on work that never needed it.

### Execution Modes — FAST is the default

| Mode | When | Routing | Gates |
|------|------|---------|-------|
| **FAST (default)** | Simple/single-domain: bug fix, one-file review, quick question | Main thread does it directly, or dispatches ONE specialist | evidence-validator only if the user asks or finding is CRITICAL |
| **BALANCED** | Multi-step or moderate-risk: feature build, security review, multi-file refactor | Main thread dispatches specialist(s); CTO only if multi-domain | validator on CRITICAL/HIGH if user-facing; challenger on irreversible recommendations |
| **FULL_POWER** | Strategic / high-risk / cross-domain / incident, or user says "full power" / "gold prompt" / "full team session" | session-sentinel → CTO → full team | All gates per task type (see reference doc) |

**Mode triggers:**
- Single-domain, low-risk → **FAST** (often no dispatch at all).
- "fast", "quick", "just do X" → FAST.
- Multi-step / moderate-risk → BALANCED.
- "full power" / "gold prompt" / "full team session" / incident → FULL_POWER.
- Ambiguous → **start FAST, escalate only when the task proves multi-domain or high-risk.**
- User can always override: "use FAST for this" / "go FULL_POWER".

### Hot-Path Dispatch (most common)

| User says... | Do this |
|---|---|
| "dispatch/use/ask [name]" | That named agent |
| "build / implement / fix this bug" | `elite-engineer` |
| "review Go / Python / TypeScript" | `go-expert` / `python-expert` / `typescript-expert` |
| Laravel/PHP: "Eloquent", "Form Request", "artisan", "spatie teams-mode", "PHP migration", "Laravel policy", "API Resource", BelongsToTenant/Rls/TenantContext | `laravel-expert` (on a migration, co-route `database-expert` who LEADS on RLS SQL) |
| "security review", "debug", "investigate" | `deep-reviewer` |
| "quality audit", "architecture drift" | `deep-qa` |
| "plan", "decompose this task" | `deep-planner` |
| "write tests", "test strategy" | `test-engineer` |
| "verify finding", "is this claim true" | `evidence-validator` |
| "challenge this", "devil's advocate" | `challenger` |
| "full team session" / "gold prompt" / "full power" | `session-sentinel` → `cto` (full authority) |
| incident / outage / urgent | `cto` (emergency mode) |
| Strategic / cross-domain / "should we X or Y?" | `cto` |

For everything else (infra, database, observability, api, BEAM/Elixir, frontend, benchmarking, hiring, memory, meta) → see the full dispatch tables in `docs/team/PROTOCOL_REFERENCE.md`.

### Gates — opt-in, not automatic

The expensive auto-dispatch loop (validator on every HIGH, challenger on every recommendation) is **off by default** to control cost. Apply gates deliberately:

- **evidence-validator** — dispatch when: the user asks to verify, OR a finding is `CRITICAL` and about to drive an irreversible action (deploy, migration, delete). For routine `HIGH` findings, surface them with their evidence and note they're unverified; let the user decide.
- **challenger** — dispatch before surfacing a strategic recommendation that triggers an **irreversible action** (deploy, schema change, migration, agent hire). Skip it for routine findings, status reports, and completed-work summaries.
- In **FULL_POWER** mode these revert to mandatory per the reference doc.

### Minimum Evidence Requirements (all findings)

Every finding MUST include all 7 fields, or it is UNVERIFIABLE:
`Claim` · `Evidence` (quoted source/output) · `Location` (file:line) · `Severity` (CRITICAL/HIGH/MEDIUM/LOW/INFO) · `Confidence` (HIGH/MEDIUM/LOW) · `Recommended action` (specific) · `Verification command`.

### Closing-Signal Persistence

Agent outputs end with 4 signals. After a dispatch returns, process each non-NONE one:
- `### DISPATCH RECOMMENDATION` → dispatch it (follow the chain until NONE).
- `### CROSS-AGENT FLAG` → dispatch the flagged agent.
- `### MEMORY HANDOFF` → append to `agent-memory/signal-bus/memory-handoffs.md`.
- `### EVOLUTION SIGNAL` → append to `agent-memory/signal-bus/evolution-signals.md`.

Entry format: `- (YYYY-MM-DD, agent=<name>, session=<id>) <content verbatim>`.

### Dispatch Format

For multi-agent work, `TeamCreate({team_name, description})` then dispatch with `subagent_type`, `team_name`, `name`, `prompt`. **Do NOT pass `model`** — agent frontmatter is authoritative (override only when the user explicitly asks for cost optimization). Independent tasks → multiple Agent calls in one message (they run in parallel). For trivial one-offs, skip TeamCreate. Full NEXUS team-mode protocol is in `docs/team/PROTOCOL_REFERENCE.md`.

### Blocked Generic Agents

Do NOT use built-in `Plan` / `Explore` / `general-purpose` — use `deep-planner` / the appropriate custom agent / `cto`.

---

## Project-Specific Context

> Intentionally empty. Add your architecture overview, dev commands, service URLs, env vars, and deployment notes here.

### Architecture Overview

### Development Commands

### Key Technical Patterns

### Environment Configuration

### Deployment Notes
