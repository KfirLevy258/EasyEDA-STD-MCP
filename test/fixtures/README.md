# Fixtures

## `synthetic-sch.json` — public, committed

A small generated schematic used by the portable test suite. Regenerate with:

```bash
node test/fixtures/make-synthetic.mjs
```

It is deliberately built to contain the cases that were hard to get right on a real board:

| Case | Why it matters |
|---|---|
| `frame_lib_1` in `schlib` | The sheet frame is not a component; failing to filter it inflates every count |
| Four disjoint `GND` netflags | Global labels are not wired together — without the merge pass GND fragments |
| A 3-point polyline wire | Wires are polylines; reading only endpoints drops interior connections |
| `U1.4` on no wire | A single-pin group is an unconnected pin, not a net |
| `C1` with `add_into_bom: no` | Must be excluded from the BOM and reported |
| `C1` with no LCSC number | Must not invent a part number |
| `10kΩ` in R0402 **and** R0603 | Same value, different package = two BOM lines |
| `TP1` with zero pins | Must still be listed |

Expected results: 5 components, GND = 4 pins, VCC = 2 pins, one 3-pin unnamed net,
4 BOM lines, 0 orphan pins, 0 name conflicts.

## Private board captures — **not committed**

Real captures are git-ignored (`test/fixtures/sch-*.json`). Tests that need one are
skipped automatically when it is absent, so a clean clone passes with no setup:

```
ℹ pass 15
ℹ skipped 25
ℹ fail 0
```

To capture your own board, attach the bridge and stream it straight to disk so the
document never passes through a model context window:

```js
// in the editor, with probe/std-bridge.js already running
window.__edaBridge.ws.send('PROBE_REPORT ' + JSON.stringify(api('getSource', { type: 'json' })));
```

A real schematic runs to roughly 900 KB — about a quarter of a million tokens. That is
the reason no tool in this server ever returns raw document JSON.

**If you capture a board you did not design, or one under NDA, keep it out of git.**
The ignore rule covers `sch-*.json` by default.
