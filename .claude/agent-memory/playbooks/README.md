# Playbooks — Reusable Task Workflows

> Planning cache for repeated task types. Reduces token cost and improves consistency over time.

## Protocol

1. **Before planning:** Check this directory for an existing playbook matching your task type
2. **If found:** Adapt the playbook to the current task — don't re-derive from scratch
3. **If not found:** After task completion, create a reusable playbook here
4. **Maintenance:** Update playbooks when workflows change; delete when obsolete

## Playbook Format

```markdown
# <Task Type> Playbook

## When to Use
<Trigger conditions — what task types match this playbook>

## Steps
1. <Step with specific files/commands to check>
2. <Step with verification criteria>
...

## Key Files
- <file-path> — <why this file matters for this task>

## Common Pitfalls
- <Thing that goes wrong and how to avoid it>

## Verification
- <How to confirm the task was done correctly>
```

## Naming Convention

`<task-type>.md` — use kebab-case, be descriptive:
- `nextjs-review.md`
- `k8s-rollout-debug.md`
- `graphql-federation-audit.md`
- `python-backend-review.md`
- `streaming-bug-debug.md`
- `secret-leak-response.md`

## Who Creates Playbooks

Any agent can propose a playbook via `### MEMORY HANDOFF` in closing protocol. `memory-coordinator` consolidates proposals into playbook files during Pattern F.

---

*This directory starts empty and is populated by the team during sessions.*
