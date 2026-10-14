---
name: validate-replay
description: Replay one Sportradar simulation recording through the wehoop-api worker and prove the change-stream invariants (idempotence, no regression, gap-free seq, outbox parity, crash recovery). Usage: /validate-replay <league> <recordingId>. Produces a dated report under devlog/evidence/replays/.
---

# /validate-replay <league> <recordingId>

Run the standard replay battery against a clean local database and write the results to `devlog/evidence/replays/<date>-<league>-<recordingId>.md`. Every section quotes the exact command and its captured output. Use the `validator` agent's rules of evidence.

## Preconditions
- `pnpm supabase status` running. Working tree clean. Note `git rev-parse HEAD`. Load `.env` first (`set -a && source .env && set +a`).
- `pnpm sim list --league <league>` shows the recording and which feeds it offers.
- **Replay source is the committed compact fixture** `fixtures/<league>/sim-<rec8>-replay.compact.jsonl.gz` (sha256 in `fixtures/<league>/README.md`; verify it with `shasum -a 256` and quote both in the report). If it does not exist yet, produce it once: `pnpm sim record --league <league> --recording <id> --out fixtures/<league>/sim-<rec8>-replay.raw.jsonl` (DB-free, natural pace, 2–3 h, raw file is git-ignored) then `pnpm sim compact --in <raw> --out <compact> --every-pbp 50 --every-summary 10 --target-mb 4`, commit the compact file and its sha256 before validating. Evidence that points at a temporary or deleted file is rejected.
- Every replay below is `pnpm dev:worker --mode sim --league <league> --replay-file <compact> --pace 0 --until closed` (≈10 s per full game); `--pace <ms>` only where a step needs time to kill the worker.

## Battery

1. **Clean replay.** `pnpm supabase db reset`, then the compact-fixture replay while `pnpm subscribe --game <uuid> --record /tmp/sub-1.jsonl` runs. Capture: final score from `games`, `count(*)` of `play_events`, `max(seq)` of `game_changes`, and the subscriber's recorded seq range. Assert seq 1..N contiguous in the recording.

2. **Idempotence.** Re-run the same replay without resetting. Capture `count(*) from game_changes` before and after; assert equal. Capture `select reason, count(*) from ingest.stale_observations group by 1`; assert `run_regresses_state` > 0 (the restart from 0–0 was rejected as stale) and note any `ambiguous_regression` rows (pregame or clockless summaries of the restarted run, held, never written).

3. **Equivalence.** `pnpm supabase db reset`, replay again into the clean DB, dump canonical state (`pnpm dump-game --game <uuid> > /tmp/run-b.json`) and diff against the dump from step 1. Assert empty diff.

4. **Crash recovery.** `pnpm supabase db reset`, start the replay, and after ~40 s `kill -9` the worker PID (record time and PID). Restart it with the same arguments to completion. Run `pnpm invariants`. Assert 0 gaps, 0 duplicates, final score equals step 1, subscriber recovered via `/changes` (grep its log for `catch-up`).

5. **Corrections.** `pnpm sim inject --game <uuid> --mutate-event <providerEventId>` then `--delete-event <providerEventId>`. Assert exactly one `event_update` and one `event_delete` appended with new seqs, and the play row updated / soft-deleted in place.

6. **Invariants.** `pnpm invariants` full output.

## Report
Write the report file with environment header, one section per step (command, output, PASS/FAIL), and a summary table. Return the path and the summary.
