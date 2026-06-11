#!/usr/bin/env bash
# sweep-stray-claude.sh
# SubagentStop / SessionStart safety-net: remove stray `.claude` trees that ended
# up OUTSIDE the repo-root `.claude/`. Empty strays are auto-removed; NON-empty
# strays are reported (never auto-deleted) so real memory is never lost — the
# fix there is to move the files into "$REPO_ROOT/.claude/..." then delete the shell.
#
# Pairs with guard-claude-memory-path.sh (PreToolUse prevention). This is the
# belt to that guard's suspenders — catches anything created via Bash mkdir or a
# path shape the guard does not intercept.
set -uo pipefail
proj="${CLAUDE_PROJECT_DIR:-$(pwd)}"
REPO_ROOT="$(git -C "$proj" rev-parse --show-toplevel 2>/dev/null || echo "$proj")"
[ -z "$REPO_ROOT" ] && exit 0

find "$REPO_ROOT" -type d -name .claude \
  -not -path "$REPO_ROOT/.claude" \
  -not -path "$REPO_ROOT/.claude/*" \
  -not -path "*/node_modules/*" \
  -not -path "*/vendor/*" 2>/dev/null | while IFS= read -r d; do
    if [ -z "$(find "$d" -type f 2>/dev/null | head -n1)" ]; then
      rm -rf "$d" && echo "[sweep-stray-claude] removed empty stray: $d"
    else
      echo "[sweep-stray-claude] WARNING non-empty stray .claude left in place — move its files into $REPO_ROOT/.claude then remove: $d" >&2
    fi
  done
exit 0
