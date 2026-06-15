# database-expert — Memory Index

<!-- Format:
- [memory-title](file.md) — one-line description
-->

- [P1 SQLite schema review](p1-sqlite-schema-review.md) — busy_timeout gap (HIGH), governor global-cap full SCAN (HIGH), action_log retention; schema otherwise sound for single-VPS 2-process
- [v2 multi-branch cap hierarchy](v2-multibranch-cap-hierarchy.md) — three-tier branch/account/global daily cap (shared-login=ban-target), account1 cap-seed=NULL-inherit ban-safety, action_log.branch_id=CASCADE rationale, governor 3-count invariant
