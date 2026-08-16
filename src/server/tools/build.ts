import type { Bridge } from '../bridge.js';
import type { BackupStore } from '../backup.js';
import { docKind } from '../model/document.js';
import { planConnection, isConnectResult, verifyConnection, findPin } from '../model/wiring.js';
import { duplicateComponent, isDuplicateFailure, verifyDuplicate } from '../model/duplicate.js';
import type { StdDocument } from '../model/types.js';

/**
 * Tools that CREATE geometry.
 *
 * Same discipline as the field editor — preview by default, snapshot before writing,
 * verify by reading back, roll back on mismatch — but with a different verifier.
 * `checkIntegrity` asserts topology never moves, which is exactly wrong here: connecting
 * pins is supposed to change it. These use intent-specific checks instead, asserting
 * that the requested change happened AND that nothing else did.
 */

export interface ConnectRequest {
  fromDesignator: string;
  fromPin: string;
  toDesignator: string;
  toPin: string;
  apply?: boolean;
}

export async function connectPins(
  bridge: Bridge,
  backups: BackupStore,
  req: ConnectRequest,
): Promise<string> {
  const doc = (await bridge.getSource()) as StdDocument | null;
  if (!doc) return 'No document is open in the editor.';
  if (docKind(doc) === 'pcb') return 'The active document is a PCB. Wiring is implemented for schematics only.';

  const from = { designator: req.fromDesignator, pinNumber: req.fromPin };
  const to = { designator: req.toDesignator, pinNumber: req.toPin };

  const plan = planConnection(doc, from, to);
  if (!isConnectResult(plan)) return `Cannot connect: ${plan.reason}`;

  const a = findPin(doc, from)!;
  const b = findPin(doc, to)!;
  const path = plan.route.points.map((p) => `(${p.x},${p.y})`).join(' -> ');

  const lines: string[] = [];
  lines.push(
    `Connect ${a.designator}.${a.pinNumber} to ${b.designator}.${b.pinNumber} ` +
      `with a ${plan.route.shape} wire:`,
  );
  lines.push(`  ${path}`);
  lines.push('');
  lines.push(
    `Resulting net: ${plan.resultingNetName ?? '(unnamed)'} with ${plan.resultingNetPins.length} pin(s) — ` +
      plan.resultingNetPins.join(' '),
  );

  if (!req.apply) {
    lines.push('');
    lines.push('PREVIEW ONLY — nothing written. Re-run with apply: true to draw this wire.');
    return lines.join('\n');
  }

  const backupId = backups.save(doc, `before-connect-${a.designator}${a.pinNumber}-${b.designator}${b.pinNumber}`);
  lines.push('');
  lines.push(`Restore point saved: ${backupId}`);

  try {
    await bridge.applySource(plan.doc);
  } catch (e) {
    lines.push(`WRITE FAILED: ${String(e)} — document unchanged.`);
    return lines.join('\n');
  }

  const after = (await bridge.getSource()) as StdDocument | null;
  if (!after) {
    lines.push('WARNING: could not read back after writing. Verify manually.');
    return lines.join('\n');
  }

  const check = verifyConnection(doc, after, { from: a, to: b });
  if (!check.ok) {
    lines.push('');
    lines.push('VERIFICATION FAILED — rolling back:');
    for (const p of check.problems) lines.push(`  - ${p}`);
    try {
      await bridge.applySource(doc);
      lines.push(`Rolled back (restore point ${backupId}).`);
    } catch (e) {
      lines.push(`ROLLBACK FAILED: ${String(e)}. Restore with easyeda_restore_backup id ${backupId}.`);
    }
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Wire drawn and verified. Net ${check.netName ?? '(unnamed)'} now has ${check.netPins.length} pin(s).`);
  return lines.join('\n');
}

export interface AddComponentRequest {
  copyOf: string;
  designator?: string;
  dx?: number;
  dy?: number;
  apply?: boolean;
}

export async function addComponent(
  bridge: Bridge,
  backups: BackupStore,
  req: AddComponentRequest,
): Promise<string> {
  const doc = (await bridge.getSource()) as StdDocument | null;
  if (!doc) return 'No document is open in the editor.';
  if (docKind(doc) === 'pcb') {
    return 'The active document is a PCB. Component placement is implemented for schematics only.';
  }

  const plan = duplicateComponent(doc, req.copyOf, {
    designator: req.designator,
    dx: req.dx,
    dy: req.dy,
  });
  if (isDuplicateFailure(plan)) return `Cannot add component: ${plan.reason}`;

  const lines: string[] = [];
  lines.push(
    `Add ${plan.designator} as a copy of ${plan.from}, offset by (${plan.offset.dx}, ${plan.offset.dy}). ` +
      `${plan.pinCount} pin(s).`,
  );
  lines.push('');
  lines.push('The new part is placed UNCONNECTED — wire it up with easyeda_connect_pins.');

  if (!req.apply) {
    lines.push('');
    lines.push('PREVIEW ONLY — nothing written. Re-run with apply: true to place it.');
    return lines.join('\n');
  }

  const backupId = backups.save(doc, `before-add-${plan.designator}`);
  lines.push('');
  lines.push(`Restore point saved: ${backupId}`);

  try {
    await bridge.applySource(plan.doc);
  } catch (e) {
    lines.push(`WRITE FAILED: ${String(e)} — document unchanged.`);
    return lines.join('\n');
  }

  const after = (await bridge.getSource()) as StdDocument | null;
  if (!after) {
    lines.push('WARNING: could not read back after writing. Verify manually.');
    return lines.join('\n');
  }

  const check = verifyDuplicate(doc, after, plan.designator, plan.pinCount);
  if (!check.ok) {
    lines.push('');
    lines.push('VERIFICATION FAILED — rolling back:');
    for (const p of check.problems) lines.push(`  - ${p}`);
    try {
      await bridge.applySource(doc);
      lines.push(`Rolled back (restore point ${backupId}).`);
    } catch (e) {
      lines.push(`ROLLBACK FAILED: ${String(e)}. Restore with easyeda_restore_backup id ${backupId}.`);
    }
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`${plan.designator} placed and verified.`);
  return lines.join('\n');
}
