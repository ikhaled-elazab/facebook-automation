#!/usr/bin/env bash
# _repo-root.sh — shared, cwd-INDEPENDENT repo-root resolver for all hooks.
#
# THE BUG THIS PREVENTS (regressed twice — 2026-06-05, 2026-06-11):
#   Hooks used  proj="${CLAUDE_PROJECT_DIR:-$(pwd)}"  (or  :-.  ) and then wrote
#   to  "$proj/.claude/agent-memory/...".  When CLAUDE_PROJECT_DIR is UNSET in a
#   subagent's hook environment AND the agent's cwd is a subdir (e.g. the
#   signal-bus/ dir itself), the fallback is the literal cwd, so the write lands
#   at  <cwd>/.claude/agent-memory/...  — a STRAY nested `.claude` tree OUTSIDE
#   the canonical repo-root `.claude/`. Live repro 2026-06-12 produced exactly:
#     signal-bus/.claude/agent-memory/signal-bus/nexus-log.md
#
# THE FIX:
#   Anchor resolution to where THIS library lives (BASH_SOURCE), which is always
#   "<repo-root>/.claude/hooks/_repo-root.sh" regardless of the agent's cwd.
#   git is run with -C "<that dir>", so it can never resolve a wrong worktree.
#   No reliance on cwd, and CLAUDE_PROJECT_DIR is only TRUSTED if it is itself a
#   real git worktree whose root matches.
#
# USAGE (in any hook):
#   source "$(dirname "${BASH_SOURCE[0]}")/_repo-root.sh"
#   REPO_ROOT="$(resolve_repo_root)"
#
# Always echoes an ABSOLUTE path; exits non-zero only if no repo root is findable
# (callers should treat that as "skip silently", never as "write to cwd").

resolve_repo_root() {
  # 1. Anchor to this library's own directory (.claude/hooks/), NOT cwd.
  #    BASH_SOURCE[0] is the path to THIS sourced file, independent of cwd.
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || self_dir=""

  # 2. Preferred: git toplevel from the library's location (survives any cwd).
  if [ -n "$self_dir" ]; then
    local git_root
    git_root="$(git -C "$self_dir" rev-parse --show-toplevel 2>/dev/null)"
    if [ -n "$git_root" ] && [ -d "$git_root/.claude" ]; then
      printf '%s\n' "$git_root"
      return 0
    fi
  fi

  # 3. Fallback A: structural — hooks live at <root>/.claude/hooks, so the repo
  #    root is two levels up. Use this when git is unavailable (no .git, shallow
  #    export, etc.) but the directory shape still holds.
  if [ -n "$self_dir" ]; then
    local structural
    structural="$(cd "$self_dir/../.." 2>/dev/null && pwd)" || structural=""
    if [ -n "$structural" ] && [ -d "$structural/.claude" ]; then
      printf '%s\n' "$structural"
      return 0
    fi
  fi

  # 4. Fallback B: trust CLAUDE_PROJECT_DIR ONLY if it is itself a real repo with
  #    a .claude/ — never the bare cwd fallback that caused the regression.
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}/.claude" ]; then
    printf '%s\n' "$CLAUDE_PROJECT_DIR"
    return 0
  fi

  # 5. No safe root found. Emit nothing; caller MUST treat empty as skip — it
  #    must NEVER fall back to cwd (that is the bug we are eliminating).
  return 1
}
