import type { Bridge } from '../bridge.js';
import type { BackupStore } from '../backup.js';
import { docKind } from '../model/document.js';
import { planConnection, isConnectResult, verifyConnection, findPin } from '../model/wiring.js';
import { duplicateComponent, isDuplicateFailure, verifyDuplicate } from '../model/duplicate.js';
import type { StdDocument } from '../model/types.js';
import { boundingBox, drawBox, verifyGraphics, type Box } from '../model/graphics.js';
import { moveComponent, isMoveFailure, verifyMove, componentPosition } from '../model/move.js';

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

/* -------------------------------------------------------------------------- *
 * Documentation graphics: boxes and labels.
 *
 * Electrically inert, so verification is absolute — the netlist must be entirely
 * unchanged and only the expected drawing objects may appear.
 * -------------------------------------------------------------------------- */

export interface DrawBoxRequest {
  designators?: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  padding?: number;
  apply?: boolean;
}

export async function drawBoxTool(
  bridge: Bridge,
  backups: BackupStore,
  req: DrawBoxRequest,
): Promise<string> {
  const doc = (await bridge.getSource()) as StdDocument | null;
  if (!doc) return 'No document is open in the editor.';
  if (docKind(doc) === 'pcb') return 'The active document is a PCB. Drawing is implemented for schematics only.';

  let box: Box;
  const lines: string[] = [];

  if (req.designators?.length) {
    const { box: bb, missing } = boundingBox(doc, req.designators, req.padding ?? 40);
    if (missing.length === req.designators.length) {
      return `None of those designators exist: ${missing.join(', ')}`;
    }
    if (missing.length) lines.push(`Note: not found, skipped — ${missing.join(', ')}`);
    box = bb;
    lines.push(
      `Box around ${req.designators.filter((d) => !missing.includes(d)).join(', ')} ` +
        `(padding ${req.padding ?? 40}).`,
    );
  } else if (
    req.x !== undefined && req.y !== undefined &&
    req.width !== undefined && req.height !== undefined
  ) {
    box = { x: req.x, y: req.y, width: req.width, height: req.height };
    lines.push('Box at explicit coordinates.');
  } else {
    return 'Give either `designators` (to wrap components) or explicit x/y/width/height.';
  }

  if (box.width <= 0 || box.height <= 0) return `Computed a degenerate box: ${JSON.stringify(box)}`;

  lines.push(`  x=${box.x} y=${box.y} w=${box.width} h=${box.height}`);
  if (req.label) lines.push(`  label: "${req.label}"`);

  const drawn = drawBox(doc, box, { label: req.label });

  if (!req.apply) {
    lines.push('');
    lines.push('PREVIEW ONLY — nothing written. Re-run with apply: true to draw it.');
    return lines.join('\n');
  }

  const backupId = backups.save(doc, `before-draw-${(req.label ?? 'box').slice(0, 16)}`);
  lines.push('');
  lines.push(`Restore point saved: ${backupId}`);

  try {
    await bridge.applySource(drawn.doc);
  } catch (e) {
    lines.push(`WRITE FAILED: ${String(e)} — document unchanged.`);
    return lines.join('\n');
  }

  const after = (await bridge.getSource()) as StdDocument | null;
  if (!after) {
    lines.push('WARNING: could not read back after writing. Verify manually.');
    return lines.join('\n');
  }

  const check = verifyGraphics(doc, after, { rects: 1, texts: req.label ? 1 : 0 });
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
  lines.push(`Drawn and verified. The netlist is unchanged — boxes and labels carry no connectivity.`);
  return lines.join('\n');
}

export interface MoveRequest {
  designator: string;
  dx: number;
  dy: number;
  apply?: boolean;
}

/**
 * Move a component, dragging its attached wire endpoints so nets survive.
 * Verification is strict: net membership must be byte-identical afterwards.
 */
export async function moveComponentTool(
  bridge: Bridge,
  backups: BackupStore,
  req: MoveRequest,
): Promise<string> {
  const doc = (await bridge.getSource()) as StdDocument | null;
  if (!doc) return 'No document is open in the editor.';
  if (docKind(doc) === 'pcb') return 'The active document is a PCB. Moving is implemented for schematics only.';

  const from = componentPosition(doc, req.designator);
  const plan = moveComponent(doc, req.designator, req.dx, req.dy);
  if (isMoveFailure(plan)) return `Cannot move: ${plan.reason}`;

  const lines: string[] = [];
  lines.push(
    `Move ${plan.designator} by (${plan.dx}, ${plan.dy})` +
      (from ? ` — from (${from.x}, ${from.y}) to (${from.x + plan.dx}, ${from.y + plan.dy})` : '') + '.',
  );
  lines.push(`  ${plan.pinsMoved} pin(s) moved, ${plan.wireVerticesDragged} wire endpoint(s) dragged with them.`);
  if (plan.wireVerticesDragged === 0 && plan.pinsMoved > 0) {
    lines.push('  (this part has no wires attached)');
  }

  if (!req.apply) {
    lines.push('');
    lines.push('PREVIEW ONLY — nothing written. Re-run with apply: true to move it.');
    return lines.join('\n');
  }

  const backupId = backups.save(doc, `before-move-${plan.designator}`);
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

  const check = verifyMove(doc, after, req.designator);
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
  lines.push('Moved and verified — every net has exactly the same membership as before.');
  return lines.join('\n');
}
