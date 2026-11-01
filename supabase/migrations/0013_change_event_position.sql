-- M5 S2 (owner decision 2026-11-01, "option 3"): the provider's ordering key of a
-- play travels with the change that carries the play, so a client folding the
-- stream orders events exactly as the snapshot does (period sequence, provider
-- sequence, provider number, wall clock, provider event id; nulls first). Without
-- it the client cannot: the body has no provider sequence, arrival order differs
-- from the snapshot's at 24 of 408 positions on the WNBA replay (the provider
-- inserts plays after the fact), and 112 neighbouring plays share period and clock.
--
-- Written once, at insert time, from the normalized event (the position the play
-- had in that revision), like the body: game_changes stays append-only and
-- /changes stays decoded-equal to the broadcast. Null on rows written before this
-- migration and on every change that is not an event_insert / event_update.
alter table public.game_changes
  add column provider_sequence bigint,
  add column provider_number   int;

comment on column public.game_changes.provider_sequence is 'event_insert / event_update: play_events.provider_sequence of that revision (the client''s ordering key); null otherwise and before 0013.';
comment on column public.game_changes.provider_number is 'event_insert / event_update: play_events.provider_number of that revision; null otherwise and before 0013.';
