---
name: milestone
description: Run one wehoop-api milestone end to end with the implementer, reviewer, validator, and devlog subagents. Usage: /milestone <n> [slug]. Stops and reports if review blockers persist after two loops or if evidence is incomplete.
---

# /milestone <n> [slug]

Orchestrate milestone M<n> of `docs/PLAN.md` through the four agents in `.claude/agents/`. You are the coordinator: you do not implement, review, or validate yourself. You delegate, relay results, and enforce the gates.

## Steps

1. **Prepare**
   - Read the M<n> row (scope, acceptance evidence, hours, devlog hook) from `docs/PLAN.md` and update `docs/MILESTONE.md` to point at M<n>.
   - Ensure a clean tree on `main` (`git status --porcelain` empty). Create branch `m<n>-<slug>` (slug from the argument or derived from the milestone title).
   - Confirm `pnpm supabase status` shows the local stack running if the milestone touches Postgres.

2. **Implement** → spawn `implementer` with: the M<n> scope and acceptance table verbatim, the branch name, and a reminder of the CLAUDE.md non-negotiables. Wait for its `## Handoff`.

3. **Review** → spawn `reviewer` with the branch name and the handoff. 
   - If verdict is `BLOCKED`: send the blocker list back to a new `implementer` run on the same branch. Maximum **two** review loops. If still blocked, stop and report the remaining blockers to the user.
   - `[should]` findings are passed to the implementer in the same loop if a loop is happening anyway; otherwise they are listed in the final report.

4. **Validate** → spawn `validator` with the milestone number, the acceptance table, and the final handoff's commands. 
   - If the evidence file has any `FAIL` or `NOT RUN`, stop and report which items failed. Do not proceed to devlog.

5. **Devlog** → spawn `devlog` with the milestone number and branch. It writes `devlog/NN-<slug>.md` and, only if `DEVLOG_BUFFER=1`, a Buffer idea.

6. **Commit and report**
   - Commit `devlog/` changes on the branch (`docs: devlog + evidence for M<n>`).
   - Push the branch and open a PR with `gh pr create --fill --base main` whose body links the evidence file. Do **not** merge and do **not** tag; the user merges and runs `pnpm release:tag`.
   - Final report to the user: branch, PR URL, review verdict, evidence summary table, devlog path, open shoulds/nits, and anything the user must do (merge, tag, confirm Buffer account).

## Gates (never skip)
- No commit to `main`.
- No tag before the user merges.
- Validator runs against the exact final commit of the branch (re-run if the implementer changed anything after validation).
- The milestone is DONE only when every acceptance item is PASS.
