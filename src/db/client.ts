import postgres, { type Sql } from 'postgres';

export type Db = Sql;

/**
 * Pooled connection for ordinary queries. Safe behind Supabase's transaction
 * pooler: no session state, no LISTEN, no advisory locks here.
 * Use `createSessionDb` for those.
 */
export function createDb(url: string, opts: { max?: number } = {}): Db {
  return postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // required for transaction-mode poolers
    // No key transform: postgres.camel also rewrites keys inside jsonb values (play_events.payload,
    // play_event_raw.raw, game_changes.body), which must round-trip byte-for-byte. Queries alias
    // columns explicitly instead.
  });
}
