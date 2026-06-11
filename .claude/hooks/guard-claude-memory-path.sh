#!/usr/bin/env bash
# guard-claude-memory-path.sh
# PreToolUse guard (Write|Edit|NotebookEdit): block any write whose target is a
# `.claude/` path that is NOT an absolute path under the repo-root `.claude/`.
#
# Why: agents that work from a subdir cwd (backend/, frontend/, or under .claude/)
# sometimes write memory to a RELATIVE `.claude/...` path (or rely on an unset
# $CLAUDE_PROJECT_DIR), which resolves against cwd and creates a stray `.claude`
# tree OUTSIDE the repo root. This guard makes that structurally impossible by
# requiring the canonical absolute form: "$REPO_ROOT/.claude/...".
#
# Exit 0 = allow. Exit 2 = block (stderr is surfaced to the model).
set -uo pipefail
input="$(cat)"

# Extract tool_input.file_path with robust JSON parsing.
fp="$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print((d.get("tool_input", {}) or {}).get("file_path", "") or "")
except Exception:
    print("")' 2>/dev/null || true)"

# No file_path → nothing to guard.
[ -z "$fp" ] && exit 0

# Only act on paths that target a .claude directory.
case "$fp" in
  *.claude/*|*/.claude|.claude/*|.claude) ;;
  *) exit 0 ;;
esac

# Resolve the canonical repo root.
proj="${CLAUDE_PROJECT_DIR:-$(pwd)}"
REPO_ROOT="$(git -C "$proj" rev-parse --show-toplevel 2>/dev/null || echo "$proj")"
allowed="$REPO_ROOT/.claude/"

# Allow ONLY absolute paths under the canonical repo-root .claude/.
case "$fp" in
  "$allowed"*) exit 0 ;;
esac

# Otherwise BLOCK with a corrective message.
cat >&2 <<EOF
BLOCKED stray .claude write: "$fp"
Memory/.claude writes MUST use an ABSOLUTE path under: $allowed
Build it as:  REPO_ROOT="\$(git rev-parse --show-toplevel)"  then write to  "\$REPO_ROOT/.claude/agent-memory/<agent>/<file>.md"
A relative or out-of-root .claude path resolves against cwd and creates a stray .claude tree OUTSIDE the repo root.
EOF
exit 2
