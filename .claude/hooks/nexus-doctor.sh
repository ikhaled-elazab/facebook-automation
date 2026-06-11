#!/usr/bin/env bash
#
# NEXUS Doctor — Diagnostic health check for the agent team framework.
#
# Verifies agents, hooks, settings, signal bus, trust ledger, Shadow Mind,
# contract tests, and hygiene. Run before sessions to catch misconfigurations.
#
# USAGE:
#   bash hooks/nexus-doctor.sh              # full check
#   bash hooks/nexus-doctor.sh --skip-tests # skip contract tests (faster)
#
set -uo pipefail

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Layout auto-detection: the framework lives at the repo root in the
# distribution/dev tree, but under .claude/ once installed into a project.
# Detect which so the doctor validates the layout it's actually run from.
if [ -d "$REPO_ROOT/agents" ]; then
  BASE="$REPO_ROOT"                                  # distribution / dev repo
elif [ -d "$REPO_ROOT/.claude/agents" ]; then
  BASE="$REPO_ROOT/.claude"                          # installed into <project>/.claude/
else
  _sd="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  BASE="$(dirname "${_sd:-$REPO_ROOT/hooks}")"       # fallback: parent of hooks/
fi

AGENTS_DIR="$BASE/agents"
HOOKS_DIR="$BASE/hooks"
SETTINGS="$BASE/settings.json"
SIGNAL_BUS="$BASE/agent-memory/signal-bus"
TRUST_LEDGER="$BASE/agent-memory/trust-ledger"
SHADOW_MIND="$BASE/agent-memory/shadow-mind"
TESTS_DIR="$BASE/tests/agents"

PASS=0
WARN=0
FAIL=0
SKIP_TESTS=false

[[ "${1:-}" == "--skip-tests" ]] && SKIP_TESTS=true

check_pass() { echo "  $1$(printf '%*s' $((40 - ${#1})) '')  [PASS]"; ((PASS++)); }
check_warn() { echo "  $1$(printf '%*s' $((40 - ${#1})) '')  [WARN] $2"; ((WARN++)); }
check_fail() { echo "  $1$(printf '%*s' $((40 - ${#1})) '')  [FAIL] $2"; ((FAIL++)); }

echo ""
echo "NEXUS Doctor Report"
echo "==================="
echo ""

# 1. Agents
agent_count=$(find "$AGENTS_DIR" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [ "$agent_count" -ge 30 ]; then
  check_pass "Agents: $agent_count found"
elif [ "$agent_count" -ge 20 ]; then
  check_warn "Agents: $agent_count found" "expected 32+"
else
  check_fail "Agents: $agent_count found" "expected 32+"
fi

# 2. Hooks executable
non_exec=0
for hook in "$HOOKS_DIR"/*.sh "$HOOKS_DIR"/*.py; do
  [ -f "$hook" ] || continue
  [ -x "$hook" ] || ((non_exec++))
done
if [ "$non_exec" -eq 0 ]; then
  hook_count=$(find "$HOOKS_DIR" -maxdepth 1 \( -name "*.sh" -o -name "*.py" \) 2>/dev/null | wc -l | tr -d ' ')
  check_pass "Hooks: $hook_count executable"
else
  check_warn "Hooks: $non_exec not executable" "run chmod +x"
fi

# 3. Dependencies
if command -v jq &>/dev/null; then
  check_pass "Dependencies: jq installed"
else
  check_fail "Dependencies: jq missing" "install with: brew install jq"
fi

if command -v python3 &>/dev/null; then
  check_pass "Dependencies: python3 installed"
else
  check_fail "Dependencies: python3 missing" "required for ledger + shadow mind"
fi

# 4. Settings
if [ -f "$SETTINGS" ]; then
  if jq empty "$SETTINGS" 2>/dev/null; then
    # Count registered hook commands AND verify each script path resolves.
    # Counting declarations alone gives a false PASS: if the wired paths
    # (e.g. $CLAUDE_PROJECT_DIR/.claude/hooks/x.sh) don't exist in the current
    # layout, the hooks never fire even though settings.json looks correct.
    declared=0; resolved=0; layout_miss=0; missing=""
    while IFS= read -r cmd; do
      [ -z "$cmd" ] && continue
      ((declared++))
      ref="${cmd%% *}"                       # script path is the first token
      ref="${ref//\"/}"                      # strip quotes
      path=$(printf '%s' "$ref" | sed "s|\${CLAUDE_PROJECT_DIR}|$REPO_ROOT|g; s|\$CLAUDE_PROJECT_DIR|$REPO_ROOT|g")
      if [ -f "$path" ]; then
        ((resolved++))
      elif [ -f "$HOOKS_DIR/$(basename "$path")" ]; then
        ((layout_miss++))                    # script exists, but not at the wired path
      else
        missing="$missing $(basename "$path")"
      fi
    done < <(jq -r '[.hooks // {} | to_entries[] | .value[] | .hooks[]? | .command] | .[]' "$SETTINGS" 2>/dev/null)

    if [ "$declared" -eq 0 ]; then
      check_warn "Settings: valid JSON" "no hooks registered"
    elif [ -n "$missing" ]; then
      check_fail "Settings: $declared hooks, script(s) missing" "not found:$missing"
    elif [ "$layout_miss" -gt 0 ]; then
      check_warn "Settings: $declared hooks declared, $layout_miss won't fire" "wired under .claude/ but scripts live at $HOOKS_DIR — resolves once installed into .claude/"
    else
      check_pass "Settings: valid JSON, $resolved/$declared hooks resolve"
    fi
  else
    check_fail "Settings: invalid JSON" "fix settings.json syntax"
  fi
else
  check_fail "Settings: missing" "settings.json not found"
fi

# 5. Signal bus
if [ -d "$SIGNAL_BUS" ]; then
  bus_files=$(find "$SIGNAL_BUS" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  writable=true
  for f in "$SIGNAL_BUS"/*.md; do
    [ -f "$f" ] && [ ! -w "$f" ] && writable=false
  done
  if $writable; then
    check_pass "Signal bus: $bus_files files writable"
  else
    check_warn "Signal bus: some files not writable" "check permissions"
  fi
else
  check_fail "Signal bus: directory missing" "expected at agent-memory/signal-bus/"
fi

# 6. Trust ledger
if [ -d "$TRUST_LEDGER" ]; then
  if [ -f "$TRUST_LEDGER/ledger.py" ]; then
    check_pass "Trust ledger: ledger.py present"
  else
    check_fail "Trust ledger: ledger.py missing" "trust calibration disabled"
  fi
else
  check_fail "Trust ledger: directory missing" "expected at agent-memory/trust-ledger/"
fi

# 7. Shadow Mind
if [ -d "$SHADOW_MIND" ]; then
  observer_running=false
  if [ -f "$SHADOW_MIND/heartbeats/observer.json" ]; then
    pid=$(jq -r '.pid // empty' "$SHADOW_MIND/heartbeats/observer.json" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      observer_running=true
    fi
  fi

  patterns_populated=false
  if [ -f "$SHADOW_MIND/patterns/ngrams.json" ] || \
     [ -f "$SHADOW_MIND/patterns/co_occurrences.json" ] || \
     [ -f "$SHADOW_MIND/patterns/topic_clusters.json" ]; then
    patterns_populated=true
  fi

  if $observer_running && $patterns_populated; then
    check_pass "Shadow Mind: active + patterns populated"
  elif $observer_running; then
    check_warn "Shadow Mind: observer running" "patterns not yet computed"
  elif $patterns_populated; then
    check_warn "Shadow Mind: patterns exist" "observer not running"
  else
    check_warn "Shadow Mind: installed but dormant" "run shadow-observer.sh to activate"
  fi
else
  check_warn "Shadow Mind: not installed" "optional — delete-to-disable"
fi

# 8. Contract tests
if $SKIP_TESTS; then
  echo "  Contract tests: skipped                 [SKIP]"
else
  if [ -f "$TESTS_DIR/run_contract_tests.py" ]; then
    test_output=$(cd "$REPO_ROOT" && python3 "$TESTS_DIR/run_contract_tests.py" 2>&1)
    # Parse the summary counts directly. Matching the bare word "failed" is
    # wrong because the summary always reads "N failed" (e.g. "0 failed"),
    # which made an all-green run report [FAIL].
    failed_count=$(printf '%s' "$test_output" | grep -oE '[0-9]+ failed' | grep -oE '^[0-9]+' | sed -n '1p')
    passed=$(printf '%s' "$test_output" | grep -m1 -oE '[0-9]+ passed')
    if [ "${failed_count:-0}" -gt 0 ] 2>/dev/null; then
      check_fail "Contract tests: ${failed_count} failed" "run: python3 $TESTS_DIR/run_contract_tests.py"
    elif [ -n "$passed" ]; then
      check_pass "Contract tests: $passed"
    else
      check_fail "Contract tests: runner error" "no summary line — check python3 $TESTS_DIR/run_contract_tests.py"
    fi
  else
    check_warn "Contract tests: runner missing" "expected at tests/agents/run_contract_tests.py"
  fi
fi

# 9. Hygiene
hygiene_issues=0
hygiene_details=""

if [ -f "$REPO_ROOT/.env" ]; then
  ((hygiene_issues++))
  hygiene_details="$hygiene_details .env"
fi
if [ -f "$REPO_ROOT/credentials.json" ]; then
  ((hygiene_issues++))
  hygiene_details="$hygiene_details credentials.json"
fi
if find "$REPO_ROOT" -maxdepth 2 -name ".DS_Store" -print -quit 2>/dev/null | grep -q .; then
  ((hygiene_issues++))
  hygiene_details="$hygiene_details .DS_Store"
fi
if [ -f "$REPO_ROOT/settings.local.json" ]; then
  if git -C "$REPO_ROOT" ls-files --error-unmatch "settings.local.json" &>/dev/null 2>&1; then
    ((hygiene_issues++))
    hygiene_details="$hygiene_details settings.local.json(tracked)"
  fi
fi
if [ ! -f "$REPO_ROOT/.gitignore" ]; then
  ((hygiene_issues++))
  hygiene_details="$hygiene_details no-.gitignore"
fi

if [ "$hygiene_issues" -eq 0 ]; then
  check_pass "Hygiene: clean"
else
  check_warn "Hygiene: $hygiene_issues issue(s)" "$hygiene_details"
fi

# Summary
echo ""
echo "---"
echo "Overall: $PASS PASS, $WARN WARN, $FAIL FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "Status: UNHEALTHY — fix FAIL items before session"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "Status: DEGRADED — review WARN items"
  exit 0
else
  echo "Status: HEALTHY"
  exit 0
fi
