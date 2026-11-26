# hello-aflt-seeded — portable tile-dungeon loop (M0 script seed)

**Non-default.** The canonical hello-aflt is
[`hello-aflt`](../hello-aflt/README.md) (from-scratch: docs-only seed, agent M0).

This variant scaffolds M0 with a **`type: "script"`** phase: `seed-m0.js` copies
`m0-seed/` into an empty cwd (no AI call, no credits), then runs smoke tests.

## Quick start

```bash
mkdir tile-dungeon && cd tile-dungeon && git init
aflt loop run /path/to/aflt/examples/loops/hello-aflt-seeded/hello-aflt.json
```

Continue improve (same as from-scratch; uses in-project gate on trees built either way):

```bash
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt-improve.json --allow-existing
```

See [`../hello-aflt/README.md`](../hello-aflt/README.md) for improve rules,
`plannedPhaseGate: "none"`, and making-of.