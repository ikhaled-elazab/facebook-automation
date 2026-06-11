# Team Protocol Reference (read-on-demand)

> This file holds the full detail that used to live in `CLAUDE.md`. It is **NOT** loaded into context every turn — read it only when you actually need NEXUS syscalls, Shadow Mind queries, lifecycle routing, or the full dispatch tables. `CLAUDE.md` keeps only the hot-path routing.

---

## Full Dispatch Tables

### Session Lifecycle

| User says... | Dispatch chain |
|---|---|
| Starting any work session | `session-sentinel` (pre-session brief) → then `cto` (only if non-trivial) |
| Ending any work session | `session-sentinel` (session-end audit) |
| "full team session", "gold prompt", "full power" | `session-sentinel` (pre-brief) → `cto` with full authority |
| "Pattern F", "process signal bus", "end session learning" | `memory-coordinator` + `meta-agent` (parallel) |
| "remember this", "save to memory", "what did we learn" | `memory-coordinator` |

### Direct Agent Dispatch (Single-Domain Tasks)

| User says... | Dispatch this agent |
|---|---|
| "dispatch [name]", "use [name]", "have [name]", "ask [name]" | The named agent |
| "plan", "plan remediation", "decompose this task" | `deep-planner` |
| "orchestrate", "execute this plan", "coordinate" | `orchestrator` |
| "what's the status", "progress", "where are we" | `orchestrator` |
| "review Go code" | `go-expert` |
| "review Python code" | `python-expert` |
| "review TypeScript", "review frontend" | `typescript-expert` |
| "quality audit", "check architecture drift" | `deep-qa` |
| "security review", "debug this", "investigate" | `deep-reviewer` |
| "review K8s", "review Terraform", "infra" | `infra-expert` |
| "review database", "review queries", "migration" | `database-expert` |
| "review logging", "review metrics", "SLO" | `observability-expert` |
| "write tests", "test strategy", "flaky tests" | `test-engineer` |
| "review API", "review GraphQL schema" | `api-expert` |
| "team memory", "what does the team know" | `memory-coordinator` |
| "what's deployed", "cluster state", "live pods" | `cluster-awareness` |
| "benchmark", "how does Cursor/Devin do this" | `benchmark-agent` |
| "INTUIT", "check if pattern seen before" | `intuition-oracle` (advisory) |
| "design agent system", "RAG pipeline", "LLM routing" | `ai-platform-architect` |
| "build this feature", "implement", "fix this bug" | `elite-engineer` |
| "build frontend", "build component", "streaming UX" | `frontend-platform-engineer` |
| "evolve prompts", "improve agent", "meta sweep" | `meta-agent` |
| "session audit", "team health", "protocol compliance" | `session-sentinel` |
| "verify finding", "is this claim true", "confirm" | `evidence-validator` |
| "challenge this", "counter-argument" | `challenger` |
| "design BEAM / OTP / Horde / Ra / gen_statem topology" | `beam-architect` |
| "implement Elixir / Phoenix / LiveView code" | `elixir-engineer` |
| "gRPC boundary", "Plane 2 Go edge", "Dapr sidecar" | `go-hybrid-engineer` |
| "BEAM cluster ops", "libcluster", "hot-code-load" | `beam-sre` |
| "consult Erlang Solutions", "Gate 2 validation" | `erlang-solutions-consultant` |
| "detect missing domain specialist", "team coverage gap" | `talent-scout` |
| "hire new agent", "run hiring pipeline" | `recruiter` |
| "audit engineering discipline", "anti-hallucination check" | `code-sentinel` |

### Multi-Agent Combos

| User says... | Dispatch chain |
|---|---|
| "test live API", "smoke test", "curl test" | `test-engineer` → `elite-engineer` |
| "test and benchmark", "compare features" | `test-engineer` + `benchmark-agent` (parallel) |
| "deploy", "rollout", "release", "ship it" | `deep-reviewer` + `infra-expert` (parallel) |
| "PR review", "code review" | `deep-reviewer` + relevant language expert (parallel) |
| "full audit", "comprehensive review" | `deep-qa` + `deep-reviewer` (parallel) |
| "refactor", "redesign", "clean up" | `elite-engineer` → `deep-qa` |
| "full discipline audit after implementation" | `elite-engineer` → `code-sentinel` → `deep-qa` |
| "performance", "optimize", "slow", "latency" | `deep-qa` → `elite-engineer` |
| "parallel review all code" | `orchestrator` dispatches language experts in parallel |
| "cost analysis", "spending", "budget" | `benchmark-agent` + `infra-expert` (parallel) |
| "Living Platform work", "BEAM kernel build" | `beam-architect` + `elixir-engineer` (x2) + `beam-sre` (parallel) |

### Emergency Patterns

| Situation | Dispatch |
|---|---|
| "incident", "outage", "production down", "urgent" | `cto` (emergency mode — skip pre-brief) |
| Agent is stuck, failing, or returning garbage | `cto` (reassesses + alternative approach) |

---

## Conflict Arbitration Protocol

When agents disagree, CTO MUST NOT decide by vibes:

```
DISPUTE ARBITRATION:
- Proposal A / B: [description]
- Evidence for A / B: [file:line citations]
- Cost of A / B: [effort, risk, reversibility]
- Reversibility / Risk / Testability: [A vs B]
- Trust weights: [agent-A: X.XX, agent-B: Y.YY]
- Decision + Why: [evidence-based reasoning]
```

After arbitration, challenger attacks the selected decision before implementation.

## Minimum Evidence Requirements (kept in CLAUDE.md too — the 7 fields)

Every finding MUST include: Claim, Evidence (quoted source), Location (file:line), Severity, Confidence, Recommended action, Verification command. Missing any field → UNVERIFIABLE.

## Agent Lifecycle Routing

```
trusted (5) > active (4) > probationary (3) > candidate (2) > deprecated (1)
```
Never dispatch `deprecated` or `retired` agents. `candidate` agents only for validation during onboarding.
States: `candidate` → `probationary` → `active` → `trusted` → `deprecated` → `retired`

## Implementation Workflow (Spec → Patch → Verify)

1. **SPEC** — intended behavior, affected files, risk, tests needed
2. **PATCH** — smallest correct implementation
3. **VERIFY** — run tests/build/lint or explain why impossible
4. **REVIEW** — language expert or deep-reviewer validates against spec
5. **CLOSE** — persist memory + evolution signals

## Planning Cache (Playbooks)

Before deep planning, check `agent-memory/playbooks/`. If a playbook exists → adapt it. If not → create one after task completion. Format: `<task-type>.md` with step-by-step workflow, key files, pitfalls, verification steps.

## Quality Gates by Task Type

| Task Type | Required Gates |
|-----------|---------------|
| Code change | tests, build/lint, diff summary, language-expert review |
| Security finding | evidence-validator, exploitability assessment, mitigation plan |
| Architecture decision | challenger, tradeoff matrix, rollback strategy |
| Production incident | timeline, blast radius, recovery steps, postmortem |
| New agent hire | contract tests (11×1), challenger (7 dims), meta-agent registration |
| Infrastructure change | infra-expert review, terraform plan, rollback manifest |
| Database migration | database-expert review, migration safety checklist, rollback SQL |

---

## Signal Persistence (full detail)

Every agent output ends with 4 structured signals. After ANY dispatch returns, process all 4:

| Signal | Action |
|--------|--------|
| `### DISPATCH RECOMMENDATION` | If not "NONE" → dispatch the recommended agent |
| `### CROSS-AGENT FLAG` | If not "NONE" → dispatch the flagged agent |
| `### MEMORY HANDOFF` | If not "NONE" → APPEND to `agent-memory/signal-bus/memory-handoffs.md` |
| `### EVOLUTION SIGNAL` | If not "NONE" → APPEND to `agent-memory/signal-bus/evolution-signals.md` |

Entry format: `- (YYYY-MM-DD, agent=<name>, session=<id>) <signal content verbatim>` below the `<!-- Entries below -->` marker.

---

## Dispatch Format (Team Mode)

**Step 1 — TeamCreate at session start (only for genuinely multi-agent work):**
```
TeamCreate({ team_name: "<session-topic>", description: "<purpose>" })
```

**Step 2 — Dispatch agents into the team:**
```
subagent_type: "cto"   ← or any agent name from agents/
team_name: "<session-topic>"
name: "cto-1"
prompt: "[the user's full request with context]"
# model: OMIT — agent frontmatter is authoritative
```

**Model selection rule (BINDING):** Do NOT pass a `model` parameter. The agent's frontmatter model is authoritative. Sonnet agents (5): `session-sentinel`, `evidence-validator`, `challenger`, `intuition-oracle`, `talent-scout`. Opus agents (27): everything else. Only override when the user explicitly asks for cost optimization.

**Parallel dispatch:** For independent tasks, make multiple Agent tool calls in a single message.

**Pragmatism-over-purity for instance reuse:** Reuse an existing instance that has done material prep (script edits, endpoint discovery, token validation, matrix design); re-dispatch fresh only when bias-reduction clearly outweighs prep discard.

---

## NEXUS Protocol — Team Operating System Layer

**The main thread IS the kernel.** Teammates cannot use the Agent tool, AskUserQuestion, MCP management, CronCreate, or EnterWorktree. When they need these, they send a `[NEXUS:*]` message via SendMessage to `"team-lead"`. Process immediately.

**Reply format (BINDING):** Start replies with `[NEXUS:OK <payload>]` or `[NEXUS:ERR <reason>]`.

### Privilege Boundary
```
KERNEL (Main Thread):  Agent tool, AskUserQuestion, MCP/Plugin mgmt, CronCreate, EnterWorktree
NEXUS INTERFACE:       SendMessage with [NEXUS:*] prefix
USER SPACE (Teammates): TeamCreate, SendMessage, TaskCreate, Read/Edit/Write/Bash, Web tools
```

### Syscall Table

| Syscall | Format | Main Thread Action |
|---------|--------|--------------------|
| `SPAWN` | `[NEXUS:SPAWN] agent_type \| name=X \| prompt=...` | Agent tool with team_name + name + subagent_type |
| `MCP` | `[NEXUS:MCP] server_name \| config={...}` | Install/configure MCP via settings |
| `ASK` | `[NEXUS:ASK] question` | AskUserQuestion, return answer |
| `CRON` | `[NEXUS:CRON] schedule=5m \| command=...` | CronCreate, return confirmation |
| `WORKTREE` | `[NEXUS:WORKTREE] branch=feature-x` | EnterWorktree, return path |
| `RELOAD` | `[NEXUS:RELOAD] agent_name` | Shutdown + respawn with fresh prompt |
| `SCALE` | `[NEXUS:SCALE] agent_type \| count=N \| prompt=...` | Spawn N copies agent-1..agent-N |
| `CAPABILITIES` | `[NEXUS:CAPABILITIES?]` | List available syscalls |
| `PERSIST` | `[NEXUS:PERSIST] key=X \| value=Y` | Write to durable memory file |
| `BRIDGE` | `[NEXUS:BRIDGE] from_team=X \| to_agent=Y \| message=...` | Route across teams |
| `INTUIT` | `[NEXUS:INTUIT] <question>` | Query intuition-oracle (advisory) |

### Processing Rules
1. **DETECT** — SendMessage starting with `[NEXUS:` is a syscall, not conversation.
2. **VALIDATE** — Unknown syscall → `[NEXUS:ERR] Unknown syscall: X`.
3. **AUTHORIZE** — Most auto-execute. High-risk (MCP install, prod CRON) → confirm with user.
4. **EXECUTE** — Use the appropriate main-thread-only tool.
5. **RESPOND** — `[NEXUS:OK] result` or `[NEXUS:ERR] error`.
6. **LOG** — Append to `agent-memory/signal-bus/nexus-log.md`.

**Atomic-queue-scan:** Before any `[NEXUS:OK]` reply, scan ALL unread messages from that teammate, enumerate every `[NEXUS:*]`, process atomically in timestamp order.

**Freshness re-verify:** Before proxying a destructive `[NEXUS:ASK]` if >5 min elapsed since the blocker was reported, query the teammate for a status update first.

**Challenger ledger-write mandate:** After challenger returns a verdict, write two ledger entries before continuing:
```bash
agent-memory/trust-ledger/ledger.py challenge --agent challenger --outcome <SURVIVED|MODIFIED|OVERTURNED|LOST>
agent-memory/trust-ledger/ledger.py verdict --agent <source-agent> --verdict <CONFIRMED|PARTIALLY_CONFIRMED|REFUTED>
```

### Security Tiers
| Tier | Syscalls | Authorization |
|------|----------|---------------|
| AUTO | SPAWN, CAPABILITIES, PERSIST, RELOAD, INTUIT | Execute immediately |
| CONFIRM | MCP, CRON, WORKTREE, SCALE, BRIDGE | Confirm if high-risk |
| RESTRICTED | ASK | Always proxied |

---

## Verification & Trust Infrastructure

**1. Protocol hooks** (`hooks/`): `verify-agent-protocol.sh`, `verify-signal-bus-persisted.sh`, `auto-record-trust-verdict.sh`, `log-nexus-syscall.sh`, `pre-commit-agent-contracts.sh`.

**2. Contract tests** (`tests/agents/`): `run_contract_tests.py` validates 32 agents × 11 contracts = 352 assertions.

**3. evidence-validator + challenger** — see auto-dispatch rules in CLAUDE.md.

**4. Trust ledger** (`agent-memory/trust-ledger/`): per-agent accuracy scorecard. CLI: `ledger.py` with `verdict`, `challenge`, `show`, `weight`, `standings`, `promote`, `retire`, `deprecate`.

---

## Shadow Mind (parallel cognitive layer — optional)

Non-invasive parallel layer under `agent-memory/shadow-mind/` and `hooks/shadow-*`. Six components: Observer Daemon, Pattern Computer, Pattern Library, Speculator, Dreamer, `intuition-oracle`. Agents may OPTIONALLY consult via `[NEXUS:INTUIT] <question>` → returns `INTUIT_RESPONSE v1` envelope. When observer heartbeat > 24h old → `status: SHADOW_MIND_STALE`. Delete-to-disable: removing the directory + `shadow-*` hooks takes it offline; all 352 contract tests still pass. Details in `agent-memory/shadow-mind/README.md`.

Run `hooks/nexus-doctor.sh` to check framework + Shadow Mind health.

---

## Blocked Generic Agents

Do NOT use built-in `Plan` / `Explore` / `general-purpose` — use the custom team (`deep-planner` / appropriate agent / `cto`).

## Full Roster (32 agents)
```
BUILDERS: elite-engineer, ai-platform-architect, frontend-platform-engineer, beam-architect, elixir-engineer, go-hybrid-engineer
GUARDIANS: go-expert, python-expert, typescript-expert, deep-qa, deep-reviewer, infra-expert, database-expert, observability-expert, test-engineer, api-expert, beam-sre, code-sentinel
STRATEGISTS: deep-planner, orchestrator
INTELLIGENCE: memory-coordinator, cluster-awareness, benchmark-agent, erlang-solutions-consultant, talent-scout, intuition-oracle
META: meta-agent, recruiter
GOVERNANCE: session-sentinel
CTO: cto
VERIFICATION: evidence-validator, challenger
```
