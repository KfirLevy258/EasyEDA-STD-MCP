import type { StdDocument } from './types.js';
import { num } from './document.js';
import { listComponents } from './components.js';
import { findComponentGid } from './edit.js';
import { buildNetlist } from './nets.js';
import { offsetTree } from './duplicate.js';
import { coordKey, occupiedPoints } from './wiring.js';

/**
 * Moving a component.
 *
 * Shifting the symbol is the easy half — the same absolute-coordinate transform used
 * for duplication. The half that matters is connectivity.
 *
 * In the editor, dragging a part rubber-bands its wires: they stretch to follow. Through
 * the document there is no such behaviour. Move a part and its pins walk away from the
 * wire endpoints that were sitting on them, and **every net it was on silently breaks** —
 * the schematic still looks wired because the wires are still drawn.
 *
 * So a move here drags the attached wire endpoints too: any wire vertex coincident with
 * one of the moved pins shifts by the same delta. Nets survive by construction, and the
 * verifier confirms it. The resulting wires may be diagonal rather than neatly re-routed;
 * that is cosmetic, and preferable to pretending we re-route.
 */

export interface MoveResult {
  doc: StdDocument;
  designator: string;
  dx: number;
  dy: number;
  pinsMoved: number;
  wireVerticesDragged: number;
}

export interface MoveFailure {
  reason: string;
}

export function isMoveFailure(r: MoveResult | MoveFailure): r is MoveFailure {
  return (r as MoveFailure).reason !== undefined;
}

/** Coordinates of every pin on a component, before the move. */
function pinPoints(doc: StdDocument, gId: string): string[] {
  const out: string[] = [];
  const entry = doc.schlib?.[gId];
  for (const pk of Object.keys(entry?.pin ?? {})) {
    const d = entry!.pin![pk]?.pinDot;
    const x = num(d?.x);
    const y = num(d?.y);
    if (x !== undefined && y !== undefined) out.push(coordKey({ x, y }));
  }
  return out;
}

export function moveComponent(
  doc: StdDocument,
  designator: string,
  dx: number,
  dy: number,
): MoveResult | MoveFailure {
  const gId = findComponentGid(doc, designator);
  if (!gId) return { reason: `no component with designator "${designator}"` };
  if (dx === 0 && dy === 0) return { reason: 'offset is zero — nothing to do' };

  const originalPins = new Set(pinPoints(doc, gId));

  const next = JSON.parse(JSON.stringify(doc)) as StdDocument;
  if (!offsetTree(next.schlib![gId], dx, dy)) {
    return {
      reason:
        `the symbol for ${designator} contains geometry this tool cannot safely transform ` +
        '(an SVG arc, or an unrecognised path command). Refusing rather than corrupting it.',
    };
  }

  // Drag every wire endpoint that was sitting on one of this component's pins.
  let dragged = 0;
  for (const wg of Object.keys(next.wire ?? {})) {
    const pts = next.wire![wg]?.pointArr ?? [];
    for (const p of pts) {
      const x = num(p.x);
      const y = num(p.y);
      if (x === undefined || y === undefined) continue;
      if (!originalPins.has(coordKey({ x, y }))) continue;
      p.x = x + dx;
      p.y = y + dy;
      dragged++;
    }
  }

  // Landing a pin on top of unrelated geometry would merge nets.
  const occupiedAfter = occupiedPoints(doc);
  for (const key of pinPoints(next, gId)) {
    if (originalPins.has(key)) continue; // it moved onto its own old spot; fine
    const hit = occupiedAfter.get(key);
    if (hit && !hit.startsWith(`pin ${designator}.`)) {
      return {
        reason:
          `moving ${designator} would land a pin on ${hit}, which would merge nets. ` +
          'Choose a different offset.',
      };
    }
  }

  return {
    doc: next,
    designator,
    dx,
    dy,
    pinsMoved: originalPins.size,
    wireVerticesDragged: dragged,
  };
}

/**
 * Verify a move.
 *
 * A move is purely positional: every net must have exactly the same membership as
 * before. If a net's pin count moved, a wire failed to follow its pin.
 */
export function verifyMove(
  before: StdDocument,
  after: StdDocument,
  designator: string,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  const b = buildNetlist(before);
  const a = buildNetlist(after);

  if (listComponents(before).length !== listComponents(after).length) {
    problems.push('component count changed — a move must not add or remove parts');
  }
  if (Object.keys(before.wire ?? {}).length !== Object.keys(after.wire ?? {}).length) {
    problems.push('wire count changed — a move must not add or remove wires');
  }
  if (a.diagnostics.orphanPins > b.diagnostics.orphanPins) {
    problems.push(
      `orphan pins increased ${b.diagnostics.orphanPins} -> ${a.diagnostics.orphanPins} — ` +
        'a wire did not follow its pin',
    );
  }
  if (a.diagnostics.nameConflicts.length > b.diagnostics.nameConflicts.length) {
    problems.push(`net name conflict introduced: ${a.diagnostics.nameConflicts.join('; ')}`);
  }

  // Net membership must be identical, ignoring synthesised ids which are positional.
  const sig = (nl: ReturnType<typeof buildNetlist>) =>
    nl.nets
      .map((n) => `${n.name ?? ''}|${n.pins.map((p) => `${p.designator}.${p.pinNumber}`).sort().join(',')}`)
      .sort();
  const sb = sig(b);
  const sa = sig(a);
  if (sb.length !== sa.length) {
    problems.push(`net count changed: ${sb.length} -> ${sa.length}`);
  } else {
    for (let i = 0; i < sb.length; i++) {
      if (sb[i] !== sa[i]) {
        problems.push(`net membership changed: "${sb[i]}" became "${sa[i]}"`);
        break;
      }
    }
  }

  // The component itself must still be there.
  if (!listComponents(after).some((c) => c.designator === designator)) {
    problems.push(`"${designator}" is missing after the move`);
  }

  return { ok: problems.length === 0, problems };
}

/** Where a component currently sits, for reporting. */
export function componentPosition(doc: StdDocument, designator: string): { x: number; y: number } | undefined {
  const gId = findComponentGid(doc, designator);
  if (!gId) return undefined;
  const head = doc.schlib![gId].head;
  const x = num(head?.x);
  const y = num(head?.y);
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}
