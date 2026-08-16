import type { StdDocument, SchLibEntry } from './types.js';
import { num } from './document.js';
import { annotationByMark, listComponents } from './components.js';
import { findComponentGid } from './edit.js';
import { buildNetlist } from './nets.js';

/**
 * Add a component by duplicating one that already exists.
 *
 * There is no "place part" API worth trusting here: `createShape` with a library
 * `shortUrl` exists but is unverified, and would need a library lookup besides. Cloning a
 * symbol that is already in the document sidesteps both — the symbol geometry, pin
 * definitions and `c_para` are known-good because the editor itself put them there.
 *
 * The catch is that EasyEDA Std stores every coordinate ABSOLUTELY. A symbol's pins,
 * annotations, outlines and SVG path strings all carry sheet coordinates, so a duplicate
 * has to shift all of them consistently. Miss one and the symbol is drawn in two places at
 * once, or a pin sits away from its body and silently joins the wrong net.
 *
 * Anything this module cannot transform with confidence is refused rather than guessed.
 */

/** SVG path commands whose parameters are coordinate pairs we know how to shift. */
const PAIRWISE_ABS = new Set(['M', 'L', 'T']);
/** Absolute commands taking a single axis value. */
const AXIS_ABS: Record<string, 'x' | 'y'> = { H: 'x', V: 'y' };
/** Absolute curve commands: all parameters are coordinate pairs. */
const CURVE_ABS = new Set(['C', 'S', 'Q']);
/** Lowercase (relative) commands need no shifting at all. */
const RELATIVE = /^[a-z]$/;

/**
 * Offset an SVG path string. Returns null if it contains anything we cannot transform
 * safely — arcs in particular carry radii and flags mixed in with coordinates.
 */
export function offsetPathString(path: string, dx: number, dy: number): string | null {
  const tokens = path.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  if (!tokens) return null;

  const out: string[] = [];
  let cmd = '';
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      out.push(t);
      i++;
      if (cmd === 'A' || cmd === 'a') return null; // arcs: radii/flags mixed with coords
      if (cmd === 'Z' || cmd === 'z') continue;
      continue;
    }

    if (!cmd) return null;
    if (RELATIVE.test(cmd)) {
      out.push(t);
      i++;
      continue;
    }

    if (PAIRWISE_ABS.has(cmd) || CURVE_ABS.has(cmd)) {
      const x = Number(tokens[i]);
      const y = Number(tokens[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      out.push(String(x + dx), String(y + dy));
      i += 2;
      continue;
    }

    const axis = AXIS_ABS[cmd];
    if (axis) {
      const v = Number(t);
      if (!Number.isFinite(v)) return null;
      out.push(String(v + (axis === 'x' ? dx : dy)));
      i++;
      continue;
    }

    return null; // unknown command — refuse rather than corrupt the symbol
  }
  return out.join(' ');
}

/** Field names that hold a coordinate on some axis. */
const X_FIELDS = new Set(['x', 'x1', 'x2', 'cx']);
const Y_FIELDS = new Set(['y', 'y1', 'y2', 'cy']);

/**
 * Recursively shift every coordinate in a symbol subtree.
 * Returns false if something could not be transformed.
 */
function offsetTree(node: unknown, dx: number, dy: number): boolean {
  if (Array.isArray(node)) {
    for (const item of node) if (!offsetTree(item, dx, dy)) return false;
    return true;
  }
  if (!node || typeof node !== 'object') return true;

  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];

    if (key === 'pathString' || key === 'd') {
      if (typeof v === 'string' && v.trim() !== '') {
        const moved = offsetPathString(v, dx, dy);
        if (moved === null) return false;
        obj[key] = moved;
      }
      continue;
    }

    if (X_FIELDS.has(key) || Y_FIELDS.has(key)) {
      const n = num(v);
      if (n === undefined) continue; // empty strings etc. are left alone
      const shifted = n + (X_FIELDS.has(key) ? dx : dy);
      // Preserve the original encoding: Std mixes numbers and numeric strings.
      obj[key] = typeof v === 'number' ? shifted : String(shifted);
      continue;
    }

    if (v && typeof v === 'object') {
      if (!offsetTree(v, dx, dy)) return false;
    }
  }
  return true;
}

/** Give every gId in a subtree a fresh, unique value. */
function reassignGids(node: unknown, suffix: string): void {
  if (Array.isArray(node)) {
    for (const item of node) reassignGids(item, suffix);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === 'gId' && typeof obj[key] === 'string') {
      obj[key] = `${obj[key]}_${suffix}`;
    } else if (obj[key] && typeof obj[key] === 'object') {
      reassignGids(obj[key], suffix);
    }
  }
}

export interface DuplicateResult {
  doc: StdDocument;
  gId: string;
  designator: string;
  from: string;
  offset: { dx: number; dy: number };
  pinCount: number;
}

export interface DuplicateFailure {
  reason: string;
}

export function isDuplicateFailure(r: DuplicateResult | DuplicateFailure): r is DuplicateFailure {
  return (r as DuplicateFailure).reason !== undefined;
}

/** Next free designator in a prefix series, e.g. R1,R2,R7 -> R8. */
export function nextDesignator(doc: StdDocument, prefix: string): string {
  const used = new Set(listComponents(doc).map((c) => c.designator));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

let dupSeq = 0;

/**
 * Duplicate a component at an offset. Coordinates are in EasyEDA's internal pixel units,
 * the same units `getSource` reports — 10 units is one 0.1in grid step at default zoom.
 */
export function duplicateComponent(
  doc: StdDocument,
  sourceDesignator: string,
  opts: { designator?: string; dx?: number; dy?: number } = {},
): DuplicateResult | DuplicateFailure {
  const srcGid = findComponentGid(doc, sourceDesignator);
  if (!srcGid) return { reason: `no component with designator "${sourceDesignator}"` };

  const dx = opts.dx ?? 100;
  const dy = opts.dy ?? 0;
  if (dx === 0 && dy === 0) {
    return { reason: 'offset is zero — the copy would sit exactly on top of the original' };
  }

  const next = JSON.parse(JSON.stringify(doc)) as StdDocument;
  const clone = JSON.parse(JSON.stringify(next.schlib![srcGid])) as SchLibEntry;

  if (!offsetTree(clone, dx, dy)) {
    return {
      reason:
        `the symbol for ${sourceDesignator} contains geometry this tool cannot safely ` +
        'transform (an SVG arc, or an unrecognised path command). Refusing rather than ' +
        'producing a corrupted copy.',
    };
  }

  const suffix = `mcpdup${++dupSeq}`;
  reassignGids(clone, suffix);

  // Choose the new designator.
  const prefix = (sourceDesignator.match(/^[A-Za-z_]+/) ?? ['U'])[0];
  const designator = opts.designator ?? nextDesignator(next, prefix);
  if (listComponents(next).some((c) => c.designator === designator)) {
    return { reason: `designator "${designator}" is already used` };
  }

  // Set the visible designator annotation (mark "P").
  let set = false;
  for (const k of Object.keys(clone.annotation ?? {})) {
    if (clone.annotation![k]?.mark === 'P') {
      clone.annotation![k].string = designator;
      set = true;
    }
  }
  if (!set) return { reason: `the symbol for ${sourceDesignator} has no designator annotation to rename` };

  const newGid = `${srcGid}_${suffix}`;
  if (clone.head) {
    clone.head.gId = newGid;
    clone.head.uuid = `${clone.head.uuid ?? 'uuid'}_${suffix}`;
  }
  next.schlib![newGid] = clone;

  const check = annotationByMark(clone, 'P');
  if (check !== designator) return { reason: 'internal error: designator did not take' };

  return {
    doc: next,
    gId: newGid,
    designator,
    from: sourceDesignator,
    offset: { dx, dy },
    pinCount: Object.keys(clone.pin ?? {}).length,
  };
}

/**
 * Verify a duplication did exactly what was asked.
 * The new part must appear with the right pin count, every existing net must be untouched,
 * and the copy's pins must not have landed on other geometry.
 */
export function verifyDuplicate(
  before: StdDocument,
  after: StdDocument,
  designator: string,
  expectedPins: number,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const beforeList = listComponents(before);
  const afterList = listComponents(after);

  if (afterList.length !== beforeList.length + 1) {
    problems.push(`component count should have risen by 1: ${beforeList.length} -> ${afterList.length}`);
  }
  const added = afterList.find((c) => c.designator === designator);
  if (!added) problems.push(`new component "${designator}" is not present after the edit`);
  else if (added.pinCount !== expectedPins) {
    problems.push(`"${designator}" has ${added.pinCount} pins, expected ${expectedPins}`);
  }

  // Existing components must be untouched.
  const beforeByDesig = new Map(beforeList.map((c) => [c.designator, c]));
  for (const c of afterList) {
    if (c.designator === designator) continue;
    const was = beforeByDesig.get(c.designator);
    if (!was) problems.push(`unexpected component "${c.designator}" appeared`);
    else if (was.pinCount !== c.pinCount) problems.push(`"${c.designator}" pin count changed`);
  }

  // A duplicate is unconnected by definition — it must not have joined any existing net.
  const nlB = buildNetlist(before);
  const nlA = buildNetlist(after);
  const namedBefore = new Map(nlB.nets.filter((n) => n.name).map((n) => [n.name!, n.pins.length]));
  for (const n of nlA.nets) {
    if (!n.name) continue;
    const was = namedBefore.get(n.name);
    if (was !== undefined && was !== n.pins.length) {
      problems.push(`net "${n.name}" changed: ${was} -> ${n.pins.length} pins — the copy landed on existing geometry`);
    }
  }

  return { ok: problems.length === 0, problems };
}
