/**
 * Edit-layer tests. Pure functions over the synthetic fixture — no editor, no writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { applyFieldEdits, checkIntegrity, encodeCPara, findComponentGid, snapshot } from '../src/server/model/edit.js';
import { parseCPara, listComponents } from '../src/server/model/components.js';
import type { StdDocument } from '../src/server/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = () =>
  JSON.parse(readFileSync(resolve(here, '../../test/fixtures/synthetic-sch.json'), 'utf8')) as StdDocument;
const doc = load();

test('edit: c_para encode/parse round-trips', () => {
  const original = 'package`R0402`Supplier`LCSC`Supplier Part`C7003001`';
  assert.equal(encodeCPara(parseCPara(original)), original);
});

test('edit: finds a component by designator, case-insensitively', () => {
  assert.ok(findComponentGid(doc, 'U1'));
  assert.equal(findComponentGid(doc, 'u1'), findComponentGid(doc, 'U1'));
  assert.equal(findComponentGid(doc, 'NOPE'), undefined);
});

test('edit: does not mutate the input document', () => {
  const before = JSON.stringify(doc);
  applyFieldEdits(doc, [{ designator: 'U1', field: 'value', value: 'CHANGED' }]);
  assert.equal(JSON.stringify(doc), before, 'applyFieldEdits must be pure');
});

test('edit: sets a value and reports the change', () => {
  const { doc: next, changes, errors } = applyFieldEdits(doc, [
    { designator: 'U1', field: 'value', value: 'LDO33-B' },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(changes, [{ designator: 'U1', field: 'value', from: 'LDO33-A', to: 'LDO33-B' }]);
  assert.equal(listComponents(next).find((c) => c.designator === 'U1')!.name, 'LDO33-B');
});

test('edit: sets an LCSC part and implies the supplier', () => {
  // H1 has no LCSC number and no Supplier — setting the part must add both, or
  // EasyEDA shows a part number with no source.
  const { doc: next, changes } = applyFieldEdits(doc, [
    { designator: 'H1', field: 'lcsc', value: 'C123456' },
  ]);
  assert.equal(changes.length, 1);
  const h1 = listComponents(next).find((c) => c.designator === 'H1')!;
  assert.equal(h1.supplierPart, 'C123456');
  assert.equal(h1.supplier, 'LCSC');
});

test('edit: preserves other c_para keys when changing one', () => {
  const gid = findComponentGid(doc, 'U2')!;
  const before = parseCPara(doc.schlib![gid].head!.c_para);
  const { doc: next } = applyFieldEdits(doc, [
    { designator: 'U2', field: 'manufacturer', value: 'NewCorp' },
  ]);
  const after = parseCPara(next.schlib![gid].head!.c_para);
  assert.equal(after['Manufacturer'], 'NewCorp');
  for (const k of Object.keys(before)) {
    if (k === 'Manufacturer') continue;
    assert.equal(after[k], before[k], `c_para key "${k}" must survive the edit`);
  }
});

test('edit: a no-op edit produces no change', () => {
  const { changes } = applyFieldEdits(doc, [
    { designator: 'U1', field: 'value', value: 'LDO33-A' },
  ]);
  assert.deepEqual(changes, [], 'writing the same value must not count as a change');
});

test('edit: unknown designators are reported, not silently skipped', () => {
  const { changes, errors } = applyFieldEdits(doc, [
    { designator: 'U1', field: 'value', value: 'X' },
    { designator: 'NOPE', field: 'value', value: 'Y' },
  ]);
  assert.equal(changes.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /NOPE/);
});

test('edit: renaming a designator moves the component', () => {
  const { doc: next, changes } = applyFieldEdits(doc, [
    { designator: 'R4', field: 'designator', value: 'R99' },
  ]);
  assert.equal(changes[0].to, 'R99');
  const names = listComponents(next).map((c) => c.designator);
  assert.ok(names.includes('R99'));
  assert.ok(!names.includes('R4'));
});

test('integrity: a field edit leaves topology untouched', () => {
  const { doc: next } = applyFieldEdits(doc, [
    { designator: 'U1', field: 'value', value: 'SOMETHING-ELSE' },
    { designator: 'U2', field: 'lcsc', value: 'C999999' },
  ]);
  const report = checkIntegrity(doc, next);
  assert.ok(report.ok, `expected clean integrity, got: ${report.problems.join('; ')}`);
});

test('integrity: catches a deleted component', () => {
  const broken = load();
  delete broken.schlib!['schU2'];
  const report = checkIntegrity(doc, broken);
  assert.ok(!report.ok);
  assert.ok(report.problems.some((p) => p.includes('component count changed')));
});

test('integrity: catches a broken net', () => {
  const broken = load();
  // Move a GND flag off its anchor point: GND loses a pin.
  const fk = Object.keys(broken.netflag!)[0];
  broken.netflag![fk].pinDot = { x: 99999, y: 99999 };
  const report = checkIntegrity(doc, broken);
  assert.ok(!report.ok);
  assert.ok(
    report.problems.some((p) => /net "GND" pin count changed/.test(p)),
    `expected a GND pin-count problem, got: ${report.problems.join('; ')}`,
  );
});

test('integrity: catches a rail short', () => {
  const broken = load();
  // Rename every +3V3 flag to GND: the two rails merge into one net.
  for (const k of Object.keys(broken.netflag!)) {
    if (broken.netflag![k].mark?.netFlagString === '+3V3') {
      broken.netflag![k].mark!.netFlagString = 'GND';
    }
  }
  const report = checkIntegrity(doc, broken);
  assert.ok(!report.ok, 'shorting +3V3 to GND must be caught');
});

test('snapshot: reports the numbers the verifier depends on', () => {
  const s = snapshot(doc);
  assert.equal(s.components, 18);
  assert.equal(s.pins, 46);
  assert.equal(s.orphanPins, 0);
  assert.equal(s.nameConflicts, 0);
  assert.equal(s.namedNets['GND'], 12);
});
