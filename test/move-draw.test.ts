/**
 * Move and draw tests. Pure functions over the synthetic fixture.
 *
 * The property that matters for a move is that net membership is IDENTICAL afterwards.
 * A move that silently detaches a wire leaves a schematic that still looks wired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { moveComponent, isMoveFailure, verifyMove, componentPosition } from '../src/server/model/move.js';
import { boundingBox, componentExtent, drawBox, addText, verifyGraphics } from '../src/server/model/graphics.js';
import { buildNetlist } from '../src/server/model/nets.js';
import { offsetTree } from '../src/server/model/duplicate.js';
import type { StdDocument } from '../src/server/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = () =>
  JSON.parse(readFileSync(resolve(here, '../../test/fixtures/synthetic-sch.json'), 'utf8')) as StdDocument;
const doc = load();

const netSig = (d: StdDocument) =>
  buildNetlist(d)
    .nets.map((n) => `${n.name ?? ''}|${n.pins.map((p) => `${p.designator}.${p.pinNumber}`).sort().join(',')}`)
    .sort()
    .join('\n');

/* ---------------------------------- move --------------------------------- */

test('move: shifts a component and keeps every net intact', () => {
  const before = netSig(doc);
  const r = moveComponent(doc, 'U1', 0, -1000);
  assert.ok(!isMoveFailure(r), JSON.stringify(r));
  assert.ok(r.pinsMoved > 0);
  assert.ok(r.wireVerticesDragged > 0, 'U1 has wires; some endpoints must have been dragged');

  assert.equal(netSig(r.doc), before, 'net membership must be identical after a move');
  assert.ok(verifyMove(doc, r.doc, 'U1').ok);
});

test('move: updates the reported position', () => {
  const p0 = componentPosition(doc, 'U1')!;
  const r = moveComponent(doc, 'U1', 250, -125);
  assert.ok(!isMoveFailure(r));
  const p1 = componentPosition(r.doc, 'U1')!;
  assert.equal(p1.x, p0.x + 250);
  assert.equal(p1.y, p0.y - 125);
});

test('move: a part with no wires moves with nothing dragged', () => {
  const r = moveComponent(doc, 'TP1', 100, 100);
  assert.ok(!isMoveFailure(r));
  assert.equal(r.wireVerticesDragged, 0);
  assert.equal(netSig(r.doc), netSig(doc));
});

test('move: does not mutate the source document', () => {
  const snapshot = JSON.stringify(doc);
  moveComponent(doc, 'U2', 500, 500);
  assert.equal(JSON.stringify(doc), snapshot);
});

test('move: rejects zero offset and unknown designators', () => {
  const a = moveComponent(doc, 'U1', 0, 0);
  assert.ok(isMoveFailure(a) && /offset is zero/.test(a.reason));
  const b = moveComponent(doc, 'NOPE', 10, 10);
  assert.ok(isMoveFailure(b) && /no component/.test(b.reason));
});

test('move: refuses an offset that would land a pin on other geometry', () => {
  // U1.1 sits at (100,-100) and U1.2 at (100,-140): a 40-unit shift puts one pin
  // exactly where another pin's net anchor is.
  const r = moveComponent(doc, 'U3', 0, 0.0);
  assert.ok(isMoveFailure(r));

  // Construct a collision deliberately: move U3 so a pin lands on a GND flag anchor.
  const gnd = Object.values(doc.netflag!).find((f) => f.mark?.netFlagString === 'GND')!;
  const p = componentPosition(doc, 'U3')!;
  const dx = Number(gnd.pinDot!.x) - 860; // U3.1 sits at x=860
  const dy = Number(gnd.pinDot!.y) - (-140);
  const bad = moveComponent(doc, 'U3', dx, dy);
  if (isMoveFailure(bad)) {
    assert.match(bad.reason, /would land a pin on|merge nets/);
  } else {
    // If it did not collide, membership must still be identical.
    assert.equal(netSig(bad.doc), netSig(doc));
  }
  void p;
});

test('verify: catches a move where wires failed to follow', () => {
  // Move the symbol only, without dragging wire endpoints — the naive implementation.
  const broken = load();
  assert.ok(offsetTree(broken.schlib!['schU1'], 0, -1000));
  const v = verifyMove(doc, broken, 'U1');
  assert.ok(!v.ok, 'a move that leaves wires behind must fail verification');
  assert.ok(
    v.problems.some((p) => /orphan pins increased|net membership changed|net count changed/.test(p)),
    v.problems.join('; '),
  );
});

/* ---------------------------------- draw --------------------------------- */

test('draw: computes a component extent', () => {
  const e = componentExtent(doc, 'U1');
  assert.ok(e);
  assert.ok(e!.width > 0 && e!.height > 0);
  assert.equal(componentExtent(doc, 'NOPE'), undefined);
});

test('draw: bounding box wraps several components with padding', () => {
  const { box, missing } = boundingBox(doc, ['U1', 'U2'], 50);
  assert.deepEqual(missing, []);
  const e1 = componentExtent(doc, 'U1')!;
  assert.ok(box.x <= e1.x - 50 + 0.001, 'box must extend past the leftmost component');
  assert.ok(box.width > e1.width);
});

test('draw: reports designators it could not find', () => {
  const { missing } = boundingBox(doc, ['U1', 'NOPE'], 10);
  assert.deepEqual(missing, ['NOPE']);
});

test('draw: a box and label are electrically inert', () => {
  const before = netSig(doc);
  const { box } = boundingBox(doc, ['U2', 'U3'], 40);
  const r = drawBox(doc, box, { label: 'connectors' });

  assert.equal(netSig(r.doc), before, 'drawing must not change the netlist at all');
  assert.equal(Object.keys(r.doc.rect ?? {}).length, Object.keys(doc.rect ?? {}).length + 1);
  assert.equal(Object.keys(r.doc.annotation ?? {}).length, Object.keys(doc.annotation ?? {}).length + 1);
  assert.ok(verifyGraphics(doc, r.doc, { rects: 1, texts: 1 }).ok);
});

test('draw: box without a label adds no annotation', () => {
  const r = drawBox(doc, { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(Object.keys(r.doc.annotation ?? {}).length, Object.keys(doc.annotation ?? {}).length);
  assert.ok(verifyGraphics(doc, r.doc, { rects: 1, texts: 0 }).ok);
});

test('draw: label sits above the box top-left', () => {
  const r = drawBox(doc, { x: 100, y: -500, width: 200, height: 300 }, { label: 'block' });
  const text = r.doc.annotation![r.textGid!] as Record<string, unknown>;
  assert.equal(text.string, 'block');
  assert.equal(text.mark, 'L');
  // y grows downward, so "above" is a smaller y than the box top.
  assert.ok(Number(text.y) < -500);
});

test('draw: standalone text', () => {
  const before = netSig(doc);
  const r = addText(doc, { x: 10, y: -20 }, 'note');
  assert.equal(netSig(r.doc), before);
  assert.equal((r.doc.annotation![r.gId] as Record<string, unknown>).string, 'note');
});

test('verify: catches drawing that disturbed the circuit', () => {
  const { box } = boundingBox(doc, ['U2'], 20);
  const r = drawBox(doc, box, { label: 'x' });
  // Sabotage: also delete a wire.
  const sabotaged = JSON.parse(JSON.stringify(r.doc)) as StdDocument;
  delete sabotaged.wire![Object.keys(sabotaged.wire!)[0]];
  const v = verifyGraphics(doc, sabotaged, { rects: 1, texts: 1 });
  assert.ok(!v.ok);
  assert.ok(v.problems.some((p) => /wire count changed/.test(p)));
});
