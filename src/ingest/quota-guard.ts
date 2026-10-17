import type { Sql, TransactionSql } from 'postgres';
import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import type { RunSource } from './runs.js';

/** Per-product console limits supplied by config (`QUOTA_<PRODUCT>=<limit_30d>[/<reserve>]`). */
export type QuotaOverrides = Record<string, { limit30d: number; reserve: number }>;

export interface QuotaStatus {
  product: string;
  limit30d: number;
  reserve: number;
  /** When an operator confirmed the limit in the Sportradar console; null = unverified. */
  verifiedAt: Date | null;
  /** True when the limit and reserve come from config, not from ingest.product_quotas. */
  overridden: boolean;
  used30d: number;
  remaining: number;
  /** Outstanding on open trial/production reservations (reserved - used). */
  reserved: number;
  /** remaining - reserved - reserve: what a new call or reservation may take. */
  spendable: number;
}

export type QuotaRefusal = 'unknown_product' | 'unverified' | 'below_reserve';

export type QuotaDecision =
  | { ok: true; status: QuotaStatus }
  | { ok: false; reason: QuotaRefusal; status: QuotaStatus | null; detail: string };

export class QuotaRefusedError extends Error {
  constructor(
    readonly product: string,
    readonly reason: QuotaRefusal,
    readonly status: QuotaStatus | null,
    detail: string,
  ) {
    super(`quota refused for ${product}: ${reason} (${detail})`);
  }
}

export interface ReservationRequest {
  product: string;
  gameId: string | null;
  profile: string;
  calls: number;
  source: RunSource;
  runId?: number | null;
  note?: string | null;
}

export interface Reservation {
  id: number;
  product: string;
  gameId: string | null;
  profile: string;
  reservedCalls: number;
  usedCalls: number;
  source: RunSource;
  runId: number | null;
  createdAt: Date;
  releasedAt: Date | null;
}

interface QuotaRow {
  product: string;
  limit30d: number;
  reserve: number;
  verifiedAt: Date | null;
  used30d: number;
  reserved: number;
}

/** Only trial and production spend quota (CLAUDE.md non-negotiable 8). */
export function countsTowardQuota(source: RunSource): boolean {
  return source === 'trial' || source === 'production';
}

/**
 * QuotaGuard (plan §4 "Rate/quota"): reads ingest.v_quota per product and
 * ingest.product_quotas (seeded from console limits; config override), and
 * refuses a call or a reservation when `remaining - reserved < reserve`.
 * Reservations are serialized per product by locking the product_quotas row,
 * so two operators cannot both reserve the last budget.
 *
 * Simulation and fixture sources are never refused and never reserve against
 * the quota; their reservations are recorded (rehearsal evidence) but excluded
 * from `v_quota.reserved` by the view.
 */
export class QuotaGuard {
  constructor(
    private readonly deps: {
      db: Db;
      log: Logger;
      overrides?: QuotaOverrides;
    },
  ) {}

  private compose(row: QuotaRow): QuotaStatus {
    const override = this.deps.overrides?.[row.product];
    const limit30d = override?.limit30d ?? row.limit30d;
    const reserve = override?.reserve ?? row.reserve;
    const remaining = limit30d - row.used30d;
    return {
      product: row.product,
      limit30d,
      reserve,
      verifiedAt: row.verifiedAt,
      overridden: override !== undefined,
      used30d: row.used30d,
      remaining,
      reserved: row.reserved,
      spendable: remaining - row.reserved - reserve,
    };
  }

  private async rows(
    db: Sql | TransactionSql,
    product: string | null,
    lock: boolean,
  ): Promise<QuotaRow[]> {
    // The view's `reserved`/`used_30d` are recomputed here instead of read from the view so the
    // reservation path can lock the product row in the same statement set.
    const rows = await db<QuotaRow[]>`
      select q.product, q.limit_30d as "limit30d", q.reserve, q.verified_at as "verifiedAt",
             (select count(*)::int from ingest.provider_calls pc
               where pc.product = q.product and pc.quota_counted
                 and pc.called_at > now() - interval '30 days') as "used30d",
             (select coalesce(sum(greatest(br.reserved_calls - br.used_calls, 0)), 0)::int
                from ingest.budget_reservations br
               where br.product = q.product and br.released_at is null
                 and br.source in ('trial', 'production')) as reserved
      from ingest.product_quotas q
      where ${product === null ? db`true` : db`q.product = ${product}`}
      order by q.product
      ${lock ? db`for update of q` : db``}`;
    return rows;
  }

  /** Every product's quota (what `pnpm trial status` and /v1/admin/quota print). */
  async status(): Promise<QuotaStatus[]> {
    return (await this.rows(this.deps.db, null, false)).map((r) => this.compose(r));
  }

  private decide(product: string, row: QuotaRow | undefined, calls: number): QuotaDecision {
    if (!row) {
      return {
        ok: false,
        reason: 'unknown_product',
        status: null,
        detail: `no ingest.product_quotas row for ${product}`,
      };
    }
    const status = this.compose(row);
    if (status.verifiedAt === null && !status.overridden) {
      return {
        ok: false,
        reason: 'unverified',
        status,
        detail:
          'limit not confirmed from the console: run `pnpm trial quota --product ... --limit-30d N` or set QUOTA_<PRODUCT>',
      };
    }
    if (status.spendable < calls) {
      return {
        ok: false,
        reason: 'below_reserve',
        status,
        detail: `remaining ${status.remaining} - reserved ${status.reserved} - reserve ${status.reserve} = ${status.spendable} < ${calls}`,
      };
    }
    return { ok: true, status };
  }

  /**
   * May one more call be made for this product now? A call under a reservation that still has
   * budget is always allowed (its calls were subtracted when the reservation was made); a call
   * outside or beyond a reservation needs spendable >= 1.
   */
  async checkCall(
    product: string,
    source: RunSource,
    reservationId: number | null = null,
  ): Promise<QuotaDecision> {
    const [row] = await this.rows(this.deps.db, product, false);
    if (!countsTowardQuota(source)) {
      const status = row ? this.compose(row) : null;
      return status
        ? { ok: true, status }
        : {
            ok: false,
            reason: 'unknown_product',
            status: null,
            detail: `no quota row for ${product}`,
          };
    }
    if (reservationId !== null) {
      const [res] = await this.deps.db<{ reserved: number; used: number }[]>`
        select reserved_calls as reserved, used_calls as used from ingest.budget_reservations
        where id = ${reservationId} and released_at is null`;
      if (res && res.used < res.reserved && row) return { ok: true, status: this.compose(row) };
    }
    return this.decide(product, row, 1);
  }

  async assertCall(product: string, source: RunSource, reservationId: number | null = null) {
    const d = await this.checkCall(product, source, reservationId);
    if (!d.ok) {
      this.deps.log.warn(
        { product, reason: d.reason, detail: d.detail, status: d.status },
        'quota guard refused a call',
      );
      throw new QuotaRefusedError(product, d.reason, d.status, d.detail);
    }
    return d.status;
  }

  /**
   * Reserve `calls` for a game under a profile. Refuses (nothing written) when
   * `remaining - reserved < reserve` after the reservation, or while the limit is unverified.
   * Simulation/fixture reservations are recorded but never refused and never counted.
   */
  async reserve(req: ReservationRequest): Promise<Reservation> {
    if (!Number.isInteger(req.calls) || req.calls <= 0) {
      throw new Error(`reservation needs a positive integer call count, got ${req.calls}`);
    }
    return this.deps.db.begin(async (tx) => {
      const [row] = await this.rows(tx, req.product, true);
      if (countsTowardQuota(req.source)) {
        const d = this.decide(req.product, row, req.calls);
        if (!d.ok) {
          this.deps.log.warn(
            { product: req.product, calls: req.calls, reason: d.reason, detail: d.detail },
            'quota guard refused a reservation',
          );
          throw new QuotaRefusedError(req.product, d.reason, d.status, d.detail);
        }
      } else if (!row) {
        throw new QuotaRefusedError(
          req.product,
          'unknown_product',
          null,
          `no ingest.product_quotas row for ${req.product}`,
        );
      }
      const [r] = await tx<ReservationRow[]>`
        insert into ingest.budget_reservations (game_id, product, profile, reserved_calls, source, run_id, note)
        values (${req.gameId}, ${req.product}, ${req.profile}, ${req.calls}, ${req.source},
                ${req.runId ?? null}, ${req.note ?? null})
        returning id::text, product, game_id as "gameId", profile, reserved_calls as "reservedCalls",
               used_calls as "usedCalls", source::text as source, run_id::text as "runId",
               created_at as "createdAt", released_at as "releasedAt"`;
      if (!r) throw new Error('budget_reservations insert returned no row');
      const reservation = toReservation(r);
      this.deps.log.info(
        {
          reservationId: reservation.id,
          product: req.product,
          profile: req.profile,
          calls: req.calls,
          source: req.source,
          counted: countsTowardQuota(req.source),
        },
        'budget reserved',
      );
      return reservation;
    });
  }

  /** Attach the watch run that spends a reservation. */
  async attachRun(reservationId: number, runId: number): Promise<void> {
    await this.deps
      .db`update ingest.budget_reservations set run_id = ${runId} where id = ${reservationId}`;
  }

  /** One call was made under the reservation. */
  async recordUse(reservationId: number): Promise<void> {
    await this.deps
      .db`update ingest.budget_reservations set used_calls = used_calls + 1 where id = ${reservationId}`;
  }

  /** The watcher is done: unused budget returns to the product. */
  async release(reservationId: number): Promise<void> {
    await this.deps.db`update ingest.budget_reservations set released_at = now()
                       where id = ${reservationId} and released_at is null`;
  }

  async reservation(id: number): Promise<Reservation | null> {
    const [r] = await this.deps.db<ReservationRow[]>`
      select id::text, product, game_id as "gameId", profile, reserved_calls as "reservedCalls",
               used_calls as "usedCalls", source::text as source, run_id::text as "runId",
               created_at as "createdAt", released_at as "releasedAt"
      from ingest.budget_reservations where id = ${id}`;
    return r ? toReservation(r) : null;
  }

  async reservations(opts: { product?: string; openOnly?: boolean } = {}): Promise<Reservation[]> {
    const db = this.deps.db;
    const rows = await db<ReservationRow[]>`
      select id::text, product, game_id as "gameId", profile, reserved_calls as "reservedCalls",
               used_calls as "usedCalls", source::text as source, run_id::text as "runId",
               created_at as "createdAt", released_at as "releasedAt"
      from ingest.budget_reservations
      where ${opts.product ? db`product = ${opts.product}` : db`true`}
        and ${opts.openOnly ? db`released_at is null` : db`true`}
      order by id`;
    return rows.map(toReservation);
  }
}

interface ReservationRow {
  id: string;
  product: string;
  gameId: string | null;
  profile: string;
  reservedCalls: number;
  usedCalls: number;
  source: RunSource;
  runId: string | null;
  createdAt: Date;
  releasedAt: Date | null;
}

function toReservation(r: ReservationRow): Reservation {
  return {
    id: Number(r.id),
    product: r.product,
    gameId: r.gameId,
    profile: r.profile,
    reservedCalls: r.reservedCalls,
    usedCalls: r.usedCalls,
    source: r.source,
    runId: r.runId === null ? null : Number(r.runId),
    createdAt: r.createdAt,
    releasedAt: r.releasedAt,
  };
}
