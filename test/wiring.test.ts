/**
 * Wiring and placement tests. Pure functions over the synthetic fixture — no editor.
 *
 * The interesting cases are the refusals. Drawing a wire that connects the wrong things
 * is far worse than drawing no wire, because it produces a schematic that looks right.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  findPin, routeBetween, occupiedPoints, addWire, planConnection,
  isConnectResult, verifyConnection, coordKey,
} from '../src/server/model/wiring.js';
import {
  duplicateComponent, isDuplicateFailure, verifyDuplicate,
  offsetPathString, nextDesignator,
} from '../src/server/model/duplicate.js';
import { buildNetlist } from '../src/server/model/nets.js';
import { listComponents } from '../src/server/model/components.js';
import type { StdDocument } from '../src/server/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = () =>
  JSON.parse(readFileSync(resolve(here, '../../test/fixtures/synthetic-sch.json'), 'utf8')) as StdDocument;
const doc = load();

const pinsOf = (d: StdDocument, id: string) =>
  buildNetlist(d)
    .nets.find((n) => n.pins.some((p) => `${p.designator}.${p.pinNumber}` === id))
    ?.pins.map((p) => `${p.designator}.${p.pinNumber}`)
    .sort() ?? [];

/* --------------------------------- lookup -------------------------------- */

test('wiring: finds a pin and its coordinate', () => {
  const p = findPin(doc, { designator: 'U1', pinNumber: '4' });
  assert.ok(p);
  assert.deepEqual(p!.point, { x: 360, y: -120 });
  assert.equal(findPin(doc, { designator: 'NOPE', pinNumber: '1' }), undefined);
  assert.equal(findPin(doc, { designator: 'U1', pinNumber: '99' }), undefined);
});

/* --------------------------------- routing ------------------------------- */

test('wiring: same row or column routes straight', () => {
  const r = routeBetween({ x: 0, y: 0 }, { x: 100, y: 0 }, new Map());
  assert.ok('points' in r);
  assert.equal(r.shape, 'straight');
  assert.equal(r.points.length, 2);
});

test('wiring: otherwise routes a single corner', () => {
  const r = routeBetween({ x: 0, y: 0 }, { x: 100, y: 50 }, new Map());
  assert.ok('points' in r);
  assert.equal(r.shape, 'corner');
  assert.equal(r.points.length, 3);
  assert.deepEqual(r.points[0], { x: 0, y: 0 });
  assert.deepEqual(r.points[2], { x: 100, y: 50 });
  // The corner must share an axis with each endpoint.
  const [a, c, b] = r.points;
  assert.ok((c.x === a.x && c.y === b.y) || (c.y === a.y && c.x === b.x));
});

test('wiring: avoids a corner that is already occupied', () => {
  const occupied = new Map([[coordKey({ x: 100, y: 0 }), 'pin X.1']]);
  const r = routeBetween({ x: 0, y: 0 }, { x: 100, y: 50 }, occupied);
  assert.ok('points' in r);
  assert.deepEqual(r.points[1], { x: 0, y: 50 }, 'must pick the other corner');
});

test('wiring: refuses when BOTH corners are occupied', () => {
  const occupied = new Map([
    [coordKey({ x: 100, y: 0 }), 'pin X.1'],
    [coordKey({ x: 0, y: 50 }), 'wire ggeY'],
  ]);
  const r = routeBetween({ x: 0, y: 0 }, { x: 100, y: 50 }, occupied);
  assert.ok('reason' in r, 'must refuse rather than route through existing geometry');
  assert.match(r.reason, /merge nets/);
});

test('wiring: refuses two pins at the same coordinate', () => {
  const r = routeBetween({ x: 5, y: 5 }, { x: 5, y: 5 }, new Map());
  assert.ok('reason' in r);
});

test('wiring: occupiedPoints covers pins, wire vertices and netflags', () => {
  const occ = occupiedPoints(doc);
  assert.ok(occ.has(coordKey({ x: 360, y: -120 })), 'U1.4 pin should be occupied');
  assert.match(occ.get(coordKey({ x: 360, y: -120 }))!, /^pin U1\.4$/);
  // A GND flag anchor.
  assert.ok([...occ.values()].some((v) => v.startsWith('netflag GND')));
});

/* ------------------------------- connecting ------------------------------ */

test('wiring: connects two unconnected pins into a new net', () => {
  const plan = planConnection(doc, { designator: 'U1', pinNumber: '4' }, { designator: 'U2', pinNumber: '8' });
  assert.ok(isConnectResult(plan), `expected a route, got: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.resultingNetPins, ['U1.4', 'U2.8']);
  assert.equal(plan.resultingNetPins.length, 2, 'must not pick up extra pins');

  // The source document must not be touched.
  assert.equal(pinsOf(doc, 'U1.4').length, 1, 'planning must not mutate the input');
});

test('wiring: extends an existing net when joining a connected pin', () => {
  // U2.8 is unconnected; U2.3 is on SDA (4 pins). Joining them should give SDA 5 pins.
  const plan = planConnection(doc, { designator: 'U2', pinNumber: '8' }, { designator: 'U2', pinNumber: '3' });
  if (isConnectResult(plan)) {
    assert.equal(plan.resultingNetName, 'SDA');
    assert.equal(plan.resultingNetPins.length, 5);
  } else {
    // A refusal is also acceptable here if no clean corner exists — but it must say why.
    assert.match(plan.reason, /route|occupied|merge/);
  }
});

test('wiring: refuses pins that are already on the same net', () => {
  const plan = planConnection(doc, { designator: 'U2', pinNumber: '1' }, { designator: 'U3', pinNumber: '1' });
  assert.ok(!isConnectResult(plan));
  assert.match((plan as { reason: string }).reason, /already on net \+3V3/);
});

test('wiring: reports unknown pins clearly', () => {
  const p1 = planConnection(doc, { designator: 'NOPE', pinNumber: '1' }, { designator: 'U1', pinNumber: '4' });
  assert.match((p1 as { reason: string }).reason, /NOPE\.1 not found/);
  const p2 = planConnection(doc, { designator: 'U1', pinNumber: '4' }, { designator: 'U1', pinNumber: '77' });
  assert.match((p2 as { reason: string }).reason, /U1\.77 not found/);
});

/* ------------------------------ verification ----------------------------- */

test('verify: accepts the intended connection', () => {
  const plan = planConnection(doc, { designator: 'U1', pinNumber: '4' }, { designator: 'U2', pinNumber: '8' });
  assert.ok(isConnectResult(plan));
  const v = verifyConnection(doc, plan.doc, {
    from: findPin(doc, { designator: 'U1', pinNumber: '4' })!,
    to: findPin(doc, { designator: 'U2', pinNumber: '8' })!,
  });
  assert.ok(v.ok, v.problems.join('; '));
});

test('verify: catches a wire that merged into an unrelated net', () => {
  // Deliberately route a wire from an unconnected pin onto the GND rail.
  const gndFlag = Object.values(doc.netflag!).find((f) => f.mark?.netFlagString === 'GND')!;
  const u14 = findPin(doc, { designator: 'U1', pinNumber: '4' })!;
  const { doc: bad } = addWire(doc, [
    u14.point,
    { x: Number(gndFlag.pinDot!.x), y: Number(gndFlag.pinDot!.y) },
  ]);
  const v = verifyConnection(doc, bad, {
    from: u14,
    to: findPin(doc, { designator: 'U2', pinNumber: '8' })!, // claimed intent
  });
  assert.ok(!v.ok, 'a wire onto GND must not verify as a U1.4-U2.8 connection');
  assert.ok(
    v.problems.some((p) => /still on different nets|unintended pin/.test(p)),
    `expected a merge/mismatch complaint, got: ${v.problems.join('; ')}`,
  );
});

test('verify: catches an unrelated net changing', () => {
  const before = load();
  const after = load();
  // Connect U1.4 to U2.8 correctly...
  const plan = planConnection(after, { designator: 'U1', pinNumber: '4' }, { designator: 'U2', pinNumber: '8' });
  assert.ok(isConnectResult(plan));
  // ...but also break GND behind its back.
  const doc2 = JSON.parse(JSON.stringify(plan.doc)) as StdDocument;
  const fk = Object.keys(doc2.netflag!).find((k) => doc2.netflag![k].mark?.netFlagString === 'GND')!;
  doc2.netflag![fk].pinDot = { x: 88888, y: 88888 };

  const v = verifyConnection(before, doc2, {
    from: findPin(before, { designator: 'U1', pinNumber: '4' })!,
    to: findPin(before, { designator: 'U2', pinNumber: '8' })!,
  });
  assert.ok(!v.ok);
  assert.ok(v.problems.some((p) => /unrelated net "GND"/.test(p)), v.problems.join('; '));
});

/* ------------------------------- duplication ----------------------------- */

test('duplicate: offsets an SVG path', () => {
  assert.equal(offsetPathString('M 100 200 v 10', 5, -5), 'M 105 195 v 10');
  assert.equal(offsetPathString('M 0 0 L 10 10', 1, 2), 'M 1 2 L 11 12');
  assert.equal(offsetPathString('M 0 0 H 50', 3, 0), 'M 3 0 H 53');
  // Arcs carry radii and flags mixed with coordinates — refuse rather than corrupt.
  assert.equal(offsetPathString('M 0 0 A 5 5 0 0 1 10 10', 1, 1), null);
});

test('duplicate: picks the next free designator', () => {
  assert.equal(nextDesignator(doc, 'C'), 'C7');
  assert.equal(nextDesignator(doc, 'Z'), 'Z1');
});

test('duplicate: places a copy with the same pins and part data', () => {
  const r = duplicateComponent(doc, 'C1', { dx: 200, dy: 0 });
  assert.ok(!isDuplicateFailure(r), JSON.stringify(r));
  assert.equal(r.designator, 'C7');
  assert.equal(r.pinCount, 2);

  const comps = listComponents(r.doc);
  assert.equal(comps.length, listComponents(doc).length + 1);
  const copy = comps.find((c) => c.designator === 'C7')!;
  const src = comps.find((c) => c.designator === 'C1')!;
  assert.equal(copy.name, src.name);
  assert.equal(copy.footprint, src.footprint);
  assert.equal(copy.supplierPart, src.supplierPart);
});

test('duplicate: the copy is placed unconnected and breaks no nets', () => {
  const r = duplicateComponent(doc, 'C1', { dx: 500, dy: -500 });
  assert.ok(!isDuplicateFailure(r));
  const v = verifyDuplicate(doc, r.doc, r.designator, r.pinCount);
  assert.ok(v.ok, v.problems.join('; '));

  // Its pins must be on their own single-pin groups.
  const nl = buildNetlist(r.doc);
  const own = nl.nets.filter((n) => n.pins.some((p) => p.designator === 'C7'));
  for (const n of own) assert.equal(n.pins.length, 1, 'a fresh copy must not join an existing net');
});

test('duplicate: does not mutate the source document', () => {
  const before = JSON.stringify(doc);
  duplicateComponent(doc, 'U1', { dx: 300 });
  assert.equal(JSON.stringify(doc), before);
});

test('duplicate: rejects a zero offset and a taken designator', () => {
  const a = duplicateComponent(doc, 'C1', { dx: 0, dy: 0 });
  assert.ok(isDuplicateFailure(a));
  assert.match(a.reason, /offset is zero/);

  const b = duplicateComponent(doc, 'C1', { designator: 'C2', dx: 100 });
  assert.ok(isDuplicateFailure(b));
  assert.match(b.reason, /already used/);
});

test('duplicate: rejects an unknown source', () => {
  const r = duplicateComponent(doc, 'NOPE');
  assert.ok(isDuplicateFailure(r));
  assert.match(r.reason, /no component with designator/);
});

test('verify: catches a duplicate that landed on existing geometry', () => {
  // Offset of 0 in y and a contrived x that puts a pin onto the GND rail coordinate.
  const r = duplicateComponent(doc, 'C1', { dx: 0.0001, dy: 0 });
  assert.ok(!isDuplicateFailure(r));
  const v = verifyDuplicate(doc, r.doc, r.designator, r.pinCount);
  // Landing essentially on top of C1 puts the copy's pins on C1's nets.
  assert.ok(!v.ok, 'a copy overlapping existing pins must fail verification');
});

test('end to end: add a part, then wire it, with every net accounted for', () => {
  const added = duplicateComponent(doc, 'C1', { dx: 0, dy: -600 });
  assert.ok(!isDuplicateFailure(added));
  assert.ok(verifyDuplicate(doc, added.doc, added.designator, added.pinCount).ok);

  const plan = planConnection(
    added.doc,
    { designator: added.designator, pinNumber: '1' },
    { designator: 'U2', pinNumber: '8' },
  );
  if (isConnectResult(plan)) {
    assert.deepEqual(plan.resultingNetPins, ['C7.1', 'U2.8']);
    const v = verifyConnection(added.doc, plan.doc, {
      from: findPin(added.doc, { designator: added.designator, pinNumber: '1' })!,
      to: findPin(added.doc, { designator: 'U2', pinNumber: '8' })!,
    });
    assert.ok(v.ok, v.problems.join('; '));
  } else {
    assert.match(plan.reason, /route|occupied|merge/);
  }
});
