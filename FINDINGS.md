# EasyEDA Std bridge — §2 validation findings

**§2 go/no-go: PASS — confirmed on the desktop client**, the actual target
(`EasyEDA/6.5.51`, `isElectron: true`). See §6 for the CSP constraint that governs
the whole transport design, and §7 for the real schematic document structure.

---

## 1. Transport — the mixed-content question is answered

`https://easyeda.com` **can** open a WebSocket to `ws://127.0.0.1`. (Port 49620 in the
tests below; the desktop client later forced port 3579 — see §6.)

Verified three independent ways, all reaching a Node WS server:

| How it was run | Result |
|---|---|
| Page-context eval (main world) | `WS CONNECT origin=https://easyeda.com` + full echo round-trip |
| **Advanced → Extensions → Run Script…** (real user-script scope) | `BRIDGE OK`, `RECV echo:…` |
| Plain HTTP `fetch()` to the same port | `HTTP GET /probe.js origin=https://easyeda.com` → 200 |

Chrome version tested: **151**. No mixed-content block, no Local Network Access prompt,
no PNA preflight was ever sent (server logged `pna=-`).

### One caveat worth carrying forward

The **very first** WebSocket attempt in a fresh page session hung in `readyState 0`
(CONNECTING) and never reached the server — no error event, no console message.
Every subsequent attempt connected instantly. Cause not established.

This does not block anything, because the extension needs reconnect logic regardless,
but **the reconnect loop is load-bearing, not a nicety.** Do not ship a bridge that
gives up after one failed connect.

## 2. Target environment: the desktop client

Per the project owner, the real target is the **EasyEDA Std desktop client**, not Chrome.

- Installed at `~/Downloads/easyeda-mac-x64-6.5.51/EasyEDA.app` (not in `/Applications`)
- **Electron 19.1.9 / Chrome 102** — predates PNA/LNA enforcement entirely
- `config.json` → `mainURL: https://easyeda.com/editor`; renderer origin is
  `https://easyeda.com` (confirmed by `IndexedDB/https_easyeda.com_0`)
- Editor assets are also bundled locally (`Resources/editor/6.5.51.asar`) and the app
  ships its own root CA (`app.asar.unpacked/data/sslcert/`)

**Confirmed working** (`isElectron: true`, UA `EasyEDA/6.5.51`) — but *not* for the reason
assumed here. Being an older Chromium was irrelevant; the desktop client applies its own
CSP that the browser does not, and that is what actually governs the transport. See §6.

## 3. `api()` — corrections to the handoff's §3

### `api` is NOT a window global

```js
typeof api            // "function"  — inside Run Script / extension scope
typeof window.api     // "undefined" — it is not on window at all
```

`api` is injected into user-script scope only. Consequence: **the bridge must live inside a
user script or a packaged extension.** Driving the editor from devtools/CDP is not an option.
This settles §8 unknown #4.

### The dispatcher silently swallows unknown methods

```js
api = function (e, t) { if (Cn(a, e)) return a[e].call(null, t, n) }
```

`a` is the method table; `n` is the extension-instance id (a plain string like `"ex984404"`,
not a context object — verified by capturing the second argument).

**An unknown method name returns `undefined` with no error, no console warning, no throw.**
This is the single most dangerous property of the API for this project: a typo and an
unsupported operation are indistinguishable from a legitimately empty result. Every bridge
call must distinguish "method absent" from "method returned nothing" explicitly.

### Which methods actually exist

Determined with a **non-mutating membership oracle**. `easyeda.extension.extendApi(obj)`
evaluates `Cn(e,t) && !Cn(a,t) && typeof e[t]=="function"` — the read of `e[t]` short-circuits
away when the name is *already present*. So installing enumerable getters that record their own
invocation reveals table membership without adding anything:

```js
Object.defineProperty(probe, name, {
  enumerable: true,
  get: function () { touched[name] = true; return undefined; } // non-function => never installed
});
easyeda.extension.extendApi(probe);
// touched[name] === true  =>  name is ABSENT from the table
```

| Method | Present? |
|---|---|
| `getSource` | **yes** |
| `applySource` | **yes** |
| `createShape` | **yes** |
| `updateShape` | **yes** |
| `doCommand` | **yes** |
| `edit.unitConvert` | **NO** |

**`edit.unitConvert` does not exist as an `api()` method.** The handoff's §3 table lists it and
says "you will need this constantly". Unit conversion must come from somewhere else — most
likely `doCommand`, or it must be done arithmetically server-side. This needs resolving before
any geometry work, since Std stores geometry in internal pixel units.

Also absent (all guesses, none real): `getConfig`, `setConfig`, `getActiveDoc`, `getNets`,
`getComponents`, `getBom`, `getLayers`, `getSelected`, `prompt`, `messager`.
There is no convenience API — everything must be derived from `getSource`.

### `easyeda.extension` surface

`instances, extendApi, getExt, doCommand, ready, load, unload, exec, loadLocal, quickScript`

## 4. Still unknown

- **Document JSON structure — since answered for schematic, see §7.** (During the browser
  session `getSource` returned `undefined` throughout, because no document ever opened:
  the built-in example threw repeated "Permissions Error" dialogs and the user's own
  projects would not expand their children. Never diagnosed; appears specific to that
  browser session, since the desktop client dumped a document without complaint.)
- Whether `getSource` requires a declared permission when called from a packaged extension
  (Run Script produces an ephemeral extension id with no manifest).
- Net connectivity representation (§8 #5) and multi-part components (§8 #6) — both still open.

## 5. What is built and working

- `probe/std-bridge.js` — the thin RPC dispatcher from §4. Connects out to the server,
  handles `{id, method, params}` → `{id, ok, result|error}`, reconnects on drop, and is
  safe to re-run (tears down the previous instance).
- Server-side: WS server + `GET /rpc?method=…&params=…` so `api()` can be driven from the
  command line, and `GET /<name>.js` to serve probe scripts into the editor.

**The full path Claude Code → Node → WebSocket → EasyEDA → `api()` is working end-to-end**
(`__ping` returns `{hello: "easyeda-std-bridge/0.1"}`). That is §7's second reporting
milestone, reached against the browser.

The `std-bridge.js` probe build includes an `__eval` escape hatch used for all the discovery
above. **It must not ship in the Phase 1 extension.**

## How to attach the bridge (current procedure)

Server must be listening on **127.0.0.1:3579** (see §6 — no other port works).

In the desktop client, with a board open:
**Advanced → Extensions → Run Script… → "Load from js file…" →
`probe/std-bridge.js` → Run.**

Loading the file runs it in user-script scope, where `api` resolves on its own. Do **not**
bootstrap via `fetch(...).then(eval)` — that evaluates in global scope where `api` is not
visible, and it needs a `window.__eda_api = api` handoff to work at all. Loading the file
directly avoids the problem entirely.

The bridge persists until the page reloads and reconnects on drop, so one run buys a long
working session.

---

## 6. The desktop client's CSP dictates the port — this overrides §4

The desktop client injects its own Content-Security-Policy. The `connect-src` directive is:

```
connect-src wss: https: blob: 'self' http://127.0.0.1:3579 ws://127.0.0.1:3579;
```

`ws:` and `http:` are **not** allowed in general — only at the single hardcoded
port **3579**. A bridge on any other port is blocked by Chromium before a packet is
emitted: no error event, no network traffic, nothing in a server log. That silence is
the signature of this failure, and it cost a full debugging cycle to recognise.

### Consequences

- **§4's "scan ports 49620–49629" cannot work on the desktop client.** The port is
  fixed at 3579 by a policy baked into the app bundle. Bind 3579 or nothing.
- The handshake-to-confirm-identity idea in §4 becomes *more* important, not less:
  3579 is whitelisted because EasyEDA presumably intends it for its own local helper
  integration. It was free on this machine, but it is not ours by right. A collision
  is plausible, so the bridge must verify it is talking to its own server.
- `wss:` and `https:` are allowed to **any** host. If 3579 is ever taken, the fallback
  is TLS on another port — but that needs a cert the Electron app trusts. The rootCA
  shipped in `app.asar.unpacked/data/sslcert/` is an **AnyProxy MITM CA** (CN=AnyProxy,
  expires 2029) and is **not** installed in the user's keychain, so it is not a shortcut.
- The browser and the desktop client differ here. Anything proven in Chrome must be
  re-proven in the desktop client before it is believed.

## 7. Real schematic document structure (§8 #3 — answered for schematic)

From a live board in the desktop client, `api('getSource', {type:'json'})` returns an
object. `head.docType === "1"` denotes a schematic. Top-level keys:

```
itemOrder colors canvas schlib noconnectflag netflag wire rect
annotation image junction head BBox importFlag
```

Every shape collection is a `{gId: object}` map, exactly as §3 described for PCB —
so that layout is now confirmed for the schematic side too.

Observed counts on one real board (a good sense of realistic scale):

| Collection | Count | Notes |
|---|---|---|
| `itemOrder` | 825 | z-order; integer-keyed, i.e. an array |
| `schlib` | 141 | components — includes `frame_lib_1`, the **sheet frame, not a part** |
| `wire` | 343 | `pointArr` (len 2), `strokeColor`, `gId`, `locked` |
| `netflag` | 156 | nested: `configure`, `pinDot`, `mark`, `shapes` |
| `junction` | 123 | `r`, `fillColor`, `gId`, `pinDot` |
| `rect` / `annotation` | 24 / 24 | |
| `noconnectflag` | 13 | |
| `image` | 1 | |

A `schlib` entry is itself a container: `head`, `itemOrder` (78 sub-shapes on the
sampled one), `annotation`, `path`, `rect`, `polyline`, `pimage`. Component metadata
(designator, value, footprint, LCSC part) is expected under `head.c_para` — the
document `head` has a `c_para` key — but this is **not yet verified**, because the
one-shot probe only descends one level and the entry it sampled was the sheet frame.

**Caution for `easyeda_list_components`:** `frame_lib_1` is in `schlib` but is not a
component. Filtering out non-parts is required, not optional.

### Still unknown

- Field layout of a real component's `head.c_para`.
- PCB document structure (no PCB has been dumped yet).
- Net connectivity: whether it is explicit or must be derived from wire endpoints
  meeting pin coordinates (§8 #5). The presence of `netflag`/`junction` collections
  and `pinDot` sub-objects is suggestive but proves nothing yet. This determines
  whether `easyeda_trace_net` is cheap or expensive.
- Unit conversion, since `edit.unitConvert` does not exist (see §3).

## 8. Net connectivity is geometric — §8 #5 answered, algorithm validated

**There is no explicit netlist.** Verified against a real 140-component board:

- `wire` objects carry `pointArr` geometry only — no net id, no name.
- `pin` objects carry a `pinDot {x,y}` — no net id, no name.
- `netflag` objects carry `mark.netFlagString` (the net name) and a `pinDot` anchor.

So nets must be derived. The handoff warned this would make `easyeda_trace_net`
substantially more work. It is more work than the other tools, but it is **tractable and
now proven** — a prototype runs offline against the fixture and produces a clean netlist.

### The algorithm

1. Union-find over coordinates, keyed to 2dp (`x,y` rounded) to survive float noise.
2. For each `wire`, union every consecutive vertex pair in `pointArr`. Wires are
   polylines, not segments — observed lengths 2–8 points (208 are 2-point, but 135 are
   longer). Treating them as 2-point segments would silently lose connections.
3. Union each pin's `pinDot` into the graph.
4. Union each netflag's `pinDot`, recording its name.
5. **Then the step that is easy to miss:** union all netflags *sharing a name*.

### Step 5 is the whole trick

Global labels are not wired together. Before this pass the extraction produced **156
fragments**, with GND appearing as ~120 separate one-pin "nets" — one per GND symbol.
That result looks superficially fine and is completely wrong. After merging by name:

| Net | Pins |
|---|---|
| GND | 141 |
| VDD | 29 |
| RF_PA_EN | 7 |
| 3V3 | 6 |
| RF_LNA_EN | 3 |
| TX_LNA_SD | 2 |

plus **89 unnamed multi-pin local nets** (point-to-point connections with no label).
166 nets total.

### Validation signals

- **0 pins landed off-graph** (442/442 attached) — no coordinate-rounding misses.
- **0 name conflicts** — no connected component ended up with two different net names,
  which would indicate an over-merge.

Those two checks are cheap and should be kept as permanent assertions in the model layer;
they are what distinguishes a correct netlist from a plausible-looking wrong one.

### Consequences for Phase 1

- `easyeda_trace_net` is feasible and does **not** need re-scoping.
- Most nets are unnamed, so the tool must address nets by synthesised stable ids as well
  as names, and `easyeda_list_nets` should report both.
- This graph is computed once per document and reused by `list_nets`, `trace_net`, and
  `get_component`, so it belongs in `model/`, not in a tool.

## 9. Component model (schematic)

A `schlib` entry is a container: `head`, `itemOrder`, `annotation`, `pin`, plus shape
sub-collections (`ellipse`, `rect`, `path`, `polyline`, `pimage`).

- **Designator and value are in `annotation`, keyed by `mark`:**
  `mark: "P"` → designator (`string: "U1"`), `mark: "N"` → name/value (`string: "LNA-PART"`).
  They are not fields; they are text shapes.
- **`head.c_para` is a backtick-delimited key\`value\` string, not an object:**
  ```
  package`DFN-8_L2.0-W2.0-P0.50-LS2.0-TL-EP-1`Supplier`LCSC`Supplier Part`C0000000`
  Manufacturer`ACME`Manufacturer Part`LNA-PART`JLCPCB Part Class`Extended Part`...
  ```
  This is where footprint, LCSC part number, manufacturer and MPN come from — i.e. almost
  everything `easyeda_list_components` and `easyeda_get_bom` need. It must be parsed by
  splitting on backticks into pairs.
- `head` also has `bind_pcb_id` (links symbol → PCB footprint), `add_into_bom`,
  `convert_to_pcb` — `add_into_bom` matters for BOM correctness.
- Pins: `num.text` is the pin number, `name.text` the pin name, `pinDot` the connection point.

**`frame_lib_1` lives in `schlib` but is the sheet frame, not a component.** Filtering it
is mandatory: 141 `schlib` entries = 140 real parts + 1 frame.

## 10. Scale — the context guard is not theoretical

`getSource` on this one schematic returns **888 KB** of JSON. That is roughly a quarter of
a million tokens. Returning it raw from any tool would destroy the context window outright,
exactly as §4 warns.

The fixture was captured without ever passing through an agent context: with the bridge
attached, `window.__edaBridge.ws.send('PROBE_REPORT ' + JSON.stringify(src))` streams it
from the editor straight to a file on the server side. Use this pattern for all future
captures.

## 11. Writes — `createNew: true` does NOT sandbox (Phase 2)

The handoff (§3) documents `api('applySource', {source, createNew: true})` as opening
the result in a **new editor tab**, and calls it "safer for testing". Verified against
the live desktop client: **it is not true.** `createNew: true` overwrites the currently
open document. No new tab is created and the URL hash never changes.

This was found the hard way, by running a supposedly side-effect-free round-trip test on
a real board and discovering afterwards that the board had been rewritten.

**There is no dry-run and no sandbox for writes.** Any write experiment risks a live
document. Develop against a board you are willing to lose.

### The round-trip IS content-lossless

`getSource` → `applySource` with no modifications preserves everything that matters:

| | Before | After |
|---|---|---|
| Components | 140 | 140 |
| Pins / orphan pins | 442 / 0 | 442 / 0 |
| Named nets (GND/VDD/3V3/…) | 141/29/6/7/3/2 | identical |

What *does* change is serialization: `gId` is hoisted to the front of each `head`, and
numeric coordinates become strings (`"x": 0` → `"x": "0"`). Byte length drops (908,828 →
886,096) with no loss of content — EasyEDA re-normalising its own format on import.

Consequences:
- **Never diff documents by byte length or JSON string equality.** Compare structure.
- A second `getSource` immediately after is byte-stable, so `getSource` itself is
  deterministic — the difference really is the write, not read noise.

### `applySource` reports nothing

It returns `undefined` on success — and, per §3, also returns `undefined` for an unknown
method name. **Its return value carries no information.** Every write must be verified by
reading the document back. This is not defensive style; it is the only available signal.

### The write architecture that follows

Because there is no sandbox and no return value, every write goes through one path:

```
snapshot to disk  ->  edit in memory  ->  integrity check  ->  write
                  ->  read back       ->  verify           ->  roll back on mismatch
```

- `applySource` has exactly one call site (`Bridge.applySource`), enforced by a test.
- Edits **preview by default**; writing requires an explicit `apply: true`.
- An edit with neither `designators` nor `filter` is refused rather than applied to
  every component.
- Integrity comparison covers component/pin/wire/vertex/net counts and every named net's
  pin count, so a field edit that silently altered topology is caught and rolled back.

`createShape` and `updateShape` exist in the method table but remain unused — they would
need the same gating, and a test asserts they stay unused until that is built.

## 12. Creating geometry (Phase 3)

Adding wires and parts needs **no new API**. `applySource` writes the whole document, so a
new wire is just another entry in `doc.wire` and a new part another entry in `doc.schlib`.
`createShape` and `updateShape` remain unused.

Demonstrated on the reference synthetic board: adding one `wire` object with a two-point
`pointArr` joined two previously-unconnected pins into a net, with 0 orphan pins and 0 name
conflicts.

### Verification has to change shape

The field-edit verifier (`checkIntegrity`) asserts topology **never** moves. That is exactly
wrong for wiring, where moving topology is the point — it flags a correct new wire as:

```
wire count changed: 18 -> 19
net count changed: 12 -> 11
```

So geometry edits use intent-specific verification instead (`verifyConnection`,
`verifyDuplicate`), asserting the requested change happened **and nothing else did**:

- the two pins now share a net
- that net gained *only* the pins the two were already on — no accidental merge
- every unrelated named net has the same pin count
- no pin became orphaned, no net acquired a second name

A test drives a wire deliberately onto the GND rail and confirms it fails verification.

### Routing is refused rather than guessed

A wire connects only where its **vertices** coincide with a pin or another wire's vertex;
crossing mid-segment does not connect, matching the editor. So the danger is a vertex landing
somewhere unintended. Routing is therefore limited to a straight run or a single right-angle
corner, and if both candidate corners are occupied the connection is **refused**. Drawing no
wire is much better than drawing one that looks right and shorts two nets.

### Duplication must move every coordinate

Std stores all symbol geometry in **absolute** sheet coordinates — pins, annotations,
outlines and SVG `pathString`s alike. A duplicate has to shift all of them together; miss one
and the symbol renders in two places, or a pin sits away from its body and joins the wrong
net. `offsetPathString` handles absolute `M/L/T/H/V/C/S/Q` and leaves relative commands alone.
**SVG arcs are refused** — `A` mixes radii and flags in with coordinates, and a wrong guess
corrupts the symbol silently.

### Verified against a live editor

Run end to end on a real board (4 components, 48 nets), with the board restored afterwards:

| Step | Result |
|---|---|
| Place a 14-pin part by duplication | `U5 placed and verified` — 4 components → 5 |
| Draw a straight wire between two of its pins | `Wire drawn and verified`, new net `N$49` = `U5.1 U5.14` |
| Preview an L-shaped route to another part | corner at `(710,-685)`; **correctly predicted a 3-pin net** (`U1.40 U4.9 U5.5`), because the target pin was already tied to `U1.40` |
| Connect two pins already on one net | refused: *already on net N$1* |
| Connect a pin that does not exist | refused: *pin U5.99 not found* |
| Restore the pre-test snapshot | back to 4 components / 48 wires / 48 nets, net membership identical |

The L-route case is the one worth noting: the preview surfaced that the connection would
*extend* an existing net rather than create a fresh two-pin one, **before** anything was
written. That is the difference between a tool you can trust with geometry and one you cannot.

## 13. Moving parts, and documentation graphics

### Moving must drag the wires

Shifting a symbol is the same absolute-coordinate transform used for duplication. The half
that matters is connectivity: the editor rubber-bands wires when you drag a part, but the
document does not. Move a part through JSON and its pins walk away from the wire endpoints
sitting on them — **every net it was on breaks silently**, while the schematic still looks
wired because the wires are still drawn.

So a move drags the endpoints too: any wire vertex coincident with a moved pin shifts by the
same delta. Nets survive by construction. Wires end up diagonal rather than re-routed, which
is cosmetic and preferable to pretending otherwise.

Verification for a move is the strictest of the three write kinds: **net membership must be
identical**, not merely consistent. A test performs the naive move (symbol only, wires left
behind) and confirms it fails verification.

A move is also refused if it would land a pin on existing geometry, using the same collision
check as routing.

### Documentation graphics are the safest write

Boxes live in top-level `rect`, labels in top-level `annotation` with `mark: "L"` and
`type: "comment"`. Neither carries electrical meaning, so verification is absolute: the
netlist must be **entirely** unchanged and only the expected drawing objects may appear.

Field shapes were copied from what the editor itself emits — a real board labels its
functional blocks with exactly this rect+annotation pattern — rather than invented.

Verified live: a box drawn around three connectors with the label "connectors" left the
document at 4 components and 48 nets with identical membership.

## 14. Every write targets whatever document is ACTIVE — guard on identity

Found in live use, not by reasoning. A sequence of moves was issued against one board;
between the first write and the second, the editor's active document changed (a tab
switch). The later calls landed on a **different board**, where they correctly failed with
"no component with designator U4" — but only by luck of the designators not existing.

`getSource` and `applySource` have no document parameter. They act on whatever is in front
of the editor at that instant. Consequences:

- A read-modify-write sequence spanning two tool calls can straddle a document switch.
- **A restore is the dangerous case**: it writes a whole document, so restoring a snapshot
  while a different board is open would overwrite that board wholesale — silently, and with
  a plausible-looking success message.

### The guard

`head.uuid` identifies a document. So:

- **Restore refuses outright** when the snapshot's `uuid` differs from the open document's,
  naming both ids and telling the user to switch back.
- **Every write tool re-reads after writing** and compares the id. If the document changed
  mid-write it reports the mismatch and explicitly says *do not restore blindly*, because
  the obvious recovery is exactly the thing that would cause damage.

Verified live: with the wrong board open, a restore of a DWM3001C snapshot was refused —

```
REFUSING TO RESTORE — wrong document is open.
  snapshot is of document 8f8cc4de8af34de79b31067aaa6e0fd3
  editor currently shows  f4394d8b78c142899bbc794f59c7c430
```

This is the sharpest illustration of §11's point: with no sandbox and no useful return
value, safety has to come from checking what actually happened, every time.

### Explicit targeting

Refusing a bad restore is necessary but not sufficient — a *move* aimed at the wrong board
still failed only because that board happened to contain no `U3`/`U4`. So every geometry
write also accepts `expectDocument`: the caller passes the id it read from
`easyeda_get_context`, and the write is refused if the editor has moved on.

```
REFUSING — wrong document is open.
  expected 8f8cc4de8af34de79b31067aaa6e0fd3
  editor shows  f4394d8b78c142899bbc794f59c7c430
```

`easyeda_get_context` now reports the document id so a caller can pin a whole sequence of
edits to one board.
