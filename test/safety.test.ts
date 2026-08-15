/**
 * Phase 1 is read-only. This is a safety property, not a preference: this server
 * must never be able to modify a live board. Enforced by inspecting the source
 * tree, so it cannot regress by someone wiring up a mutating call later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('SAFETY: no server code can mutate the document', () => {
  const mutating = ['applySource', 'createShape', 'updateShape'];
  const scan = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...scan(p));
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  };
  for (const file of scan(resolve(repoRoot, 'src'))) {
    const src = readFileSync(file, 'utf8');
    // Allowed in comments (we document why they are excluded), never in code.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of mutating) {
      assert.ok(
        !codeOnly.includes(m),
        `${file} references the mutating API "${m}" outside a comment — Phase 1 must stay read-only`,
      );
    }
  }
});
