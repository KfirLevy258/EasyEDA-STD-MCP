/**
 * Writes exist as of Phase 2, so "no mutation anywhere" is no longer the property
 * to enforce. What must hold instead is that every write is *gated*:
 *
 *   - `applySource` has exactly one call site (Bridge.applySource) — one choke point
 *   - read-only tools never reach the write path
 *   - edits preview by default; writing requires an explicit apply
 *   - a restore point is saved before the write, not after
 *   - the result is read back and rolled back if structure moved
 *
 * These are checked against the source because they are properties of the design,
 * and a future edit could quietly remove any of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Source with comments stripped, so documentation of a rule never trips it. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('SAFETY: applySource has exactly one call site', () => {
  const hits = sources(resolve(repoRoot, 'src'))
    .filter((f) => /api\(\s*'applySource'|'applySource'/.test(code(f)))
    .map((f) => f.replace(repoRoot + '/', ''));
  assert.deepEqual(
    hits,
    ['src/server/bridge.ts'],
    'applySource must be reachable only through Bridge.applySource — one choke point to audit',
  );
});

test('SAFETY: createShape and updateShape are still unused', () => {
  // Not yet implemented. If they appear, they need the same gating as applySource
  // and this test should be updated deliberately, not deleted.
  for (const f of sources(resolve(repoRoot, 'src'))) {
    const src = code(f);
    for (const m of ['createShape', 'updateShape']) {
      assert.ok(!src.includes(m), `${f} uses ${m}, which has no safety gating yet`);
    }
  }
});

test('SAFETY: read-only tools do not import the write path', () => {
  const readOnly = [
    'src/server/tools/doctor.ts',
    'src/server/tools/list-components.ts',
    'src/server/tools/nets.ts',
    'src/server/tools/component.ts',
    'src/server/tools/bom.ts',
  ];
  for (const rel of readOnly) {
    const src = code(resolve(repoRoot, rel));
    assert.ok(!src.includes('applySource'), `${rel} must not write`);
    assert.ok(!src.includes('backup'), `${rel} must not need backups — it should not write`);
  }
});

test('SAFETY: the write path previews first, snapshots before writing, and verifies after', () => {
  const src = code(resolve(repoRoot, 'src/server/tools/edit-components.ts'));

  // Preview is the default: writing is guarded on an explicit opt-in.
  assert.ok(/if\s*\(\s*!req\.apply\s*\)/.test(src), 'must return a preview unless apply is set');

  // The snapshot must be taken before the write, not after.
  const snapshotAt = src.indexOf('backups.save');
  const writeAt = src.indexOf('bridge.applySource');
  assert.ok(snapshotAt > -1, 'must save a restore point');
  assert.ok(writeAt > -1, 'must write');
  assert.ok(snapshotAt < writeAt, 'the restore point must be saved BEFORE the write');

  // The write must be verified by reading back, and rolled back on failure.
  assert.ok(src.includes('checkIntegrity'), 'must verify integrity after writing');
  assert.ok(/rolling back|Rolled back/i.test(readFileSync(resolve(repoRoot, 'src/server/tools/edit-components.ts'), 'utf8')),
    'must roll back when verification fails');
});

test('SAFETY: every write tool previews first, snapshots before writing, and verifies after', () => {
  // Applies to the geometry tools too — these CREATE wires and parts, so a silent
  // mistake produces a schematic that looks right and is wrong.
  for (const rel of ['src/server/tools/edit-components.ts', 'src/server/tools/build.ts']) {
    const src = code(resolve(repoRoot, rel));
    assert.ok(/if\s*\(\s*!req\.apply\s*\)/.test(src), `${rel}: must preview unless apply is set`);

    const snapshotAt = src.indexOf('backups.save');
    const writeAt = src.indexOf('bridge.applySource');
    assert.ok(snapshotAt > -1 && writeAt > -1, `${rel}: must snapshot and write`);
    assert.ok(snapshotAt < writeAt, `${rel}: the restore point must be saved BEFORE the write`);

    assert.ok(/verify|checkIntegrity/.test(src), `${rel}: must verify after writing`);
    assert.ok(/Rolled back|rolling back/i.test(readFileSync(resolve(repoRoot, rel), 'utf8')),
      `${rel}: must roll back when verification fails`);
  }
});

test('SAFETY: geometry edits are verified by intent, not by "nothing changed"', () => {
  // checkIntegrity asserts topology never moves — correct for field edits, WRONG for
  // wiring, where changing topology is the point. Using it here would either reject
  // every valid wire or (if loosened) stop catching bad ones.
  const src = code(resolve(repoRoot, 'src/server/tools/build.ts'));
  assert.ok(!src.includes('checkIntegrity'), 'build.ts must not use the field-edit verifier');
  assert.ok(src.includes('verifyConnection'), 'connections need intent-specific verification');
  assert.ok(src.includes('verifyDuplicate'), 'placements need intent-specific verification');
});

test('SAFETY: no tool edits every component by default', () => {
  const src = code(resolve(repoRoot, 'src/server/tools/edit-components.ts'));
  assert.ok(
    src.includes('refusing to edit every component') || src.includes('Refusing to edit every component'),
    'an edit with neither designators nor filter must be refused, not applied to everything',
  );
});
