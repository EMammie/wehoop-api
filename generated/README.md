# generated/

Output of `pnpm gen:swift` (M5 B1, plan §3): the iOS `Contracts` module, emitted
from the Zod schemas listed in `src/contracts/registry.ts`. Committed so that
`pnpm gen:swift --check` (CI, and the unit test in
`test/unit/contracts/swift-emitter.test.ts`) fails when a schema changes without
the Swift following.

- After changing any schema in the registry: `pnpm gen:swift`, commit the diff.
- To update the app: `pnpm gen:swift --out <Wehoop>/WehoopKit/Sources/Contracts/Generated`
  (the app repo's `scripts/sync-contracts.sh` does this and records the backend commit).
- Never edit the `.swift` files by hand.

Rules the emitter follows (plan rev 4.11 (5)): every closed string union gets a
`case unknown(String)`; a discriminated union is a struct of its shared fields
plus `type: Kind` with `case unknown(String)`, so a change of a type the app does
not know still carries its `seq`.
