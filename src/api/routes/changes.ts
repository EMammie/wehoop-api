import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { type GameChange, gameChangeFromRow } from '../../model/game-change.js';
import { type ChangesPage, ChangesPageSchema } from '../../model/snapshot.js';
import type { AppEnv } from '../server.js';

const IdParam = z.object({ id: z.uuid() });
const Query = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

/**
 * GET /v1/games/:id/changes?after=&limit= (plan §5). Ordered by seq, decoded-equal
 * to Broadcast messages. Empty game: latestSeq=0, retainedFrom=1, hasMore=false.
 * after < retainedFrom-1 -> 200 with changes=[] and retainedFrom set; the client re-snapshots.
 */
export function changesRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/v1/games/:id/changes', async (c) => {
    const params = IdParam.safeParse(c.req.param());
    if (!params.success) return c.json({ error: 'invalid_game_id' }, 400);
    const query = Query.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'invalid_query', issues: query.error.issues }, 400);
    const page = await loadChanges(
      c.get('deps').db,
      params.data.id,
      query.data.after,
      query.data.limit,
    );
    if (!page) return c.json({ error: 'not_found' }, 404);
    c.header('cache-control', page.hasMore ? 'public, max-age=60' : 'no-store');
    return c.json(page);
  });

  return r;
}

export async function loadChanges(
  db: Db,
  gameId: string,
  after: number,
  limit: number,
): Promise<ChangesPage | null> {
  const [g] = await db<{ lastSeq: string; retainedFromSeq: string }[]>`
    select last_seq::text as "lastSeq", retained_from_seq::text as "retainedFromSeq"
    from public.games where id = ${gameId}`;
  if (!g) return null;
  const latestSeq = Number(g.lastSeq);
  const retainedFrom = Number(g.retainedFromSeq);
  let changes: GameChange[] = [];
  let hasMore = false;
  if (after >= retainedFrom - 1) {
    const rows = await db<
      {
        id: string;
        seq: string;
        changeType: string;
        providerEventId: string | null;
        body: unknown;
        createdAt: Date;
      }[]
    >`select id, seq::text as seq, change_type as "changeType", provider_event_id as "providerEventId", body,
             created_at as "createdAt"
      from public.game_changes c where c.game_id = ${gameId} and c.seq > ${after}
      order by c.seq limit ${limit + 1}`;
    hasMore = rows.length > limit;
    changes = rows.slice(0, limit).map((row) => gameChangeFromRow({ ...row, gameId }));
  }
  const last = changes[changes.length - 1];
  return ChangesPageSchema.parse({
    changes,
    nextAfter: last ? last.seq : after,
    latestSeq,
    hasMore,
    retainedFrom,
  });
}
