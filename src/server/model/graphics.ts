import type { StdDocument } from './types.js';
import { isSheetFrame, num } from './document.js';
import { annotationByMark } from './components.js';

/**
 * Documentation graphics: boxes and text labels drawn on the sheet.
 *
 * These live in the top-level `rect` and `annotation` collections, NOT inside a
 * component. They carry no electrical meaning — nothing in the netlist derives from
 * them — which makes them the safest possible geometry write: a correct one leaves
 * the netlist byte-identical.
 *
 * Field shapes are copied from what the editor itself produces (a real board uses
 * exactly this pattern to label functional blocks), rather than invented.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Extent of a component: every coordinate in its subtree, so the box wraps the drawn
 * symbol rather than just its pins.
 */
export function componentExtent(doc: StdDocument, designator: string): Box | undefined {
  const want = designator.trim().toLowerCase();
  for (const gId of Object.keys(doc.schlib ?? {})) {
    if (isSheetFrame(gId)) continue;
    const entry = doc.schlib![gId];
    const d = annotationByMark(entry, 'P');
    if (!d || d.toLowerCase() !== want) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      const x = num(obj['x']);
      const y = num(obj['y']);
      if (x !== undefined && y !== undefined) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === 'object') walk(v);
      }
    };
    walk(entry);
    if (!Number.isFinite(minX)) return undefined;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  return undefined;
}

/** Bounding box covering several components, with padding. */
export function boundingBox(
  doc: StdDocument,
  designators: string[],
  padding = 40,
): { box: Box; missing: string[] } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const missing: string[] = [];

  for (const d of designators) {
    const e = componentExtent(doc, d);
    if (!e) {
      missing.push(d);
      continue;
    }
    minX = Math.min(minX, e.x);
    minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + e.width);
    maxY = Math.max(maxY, e.y + e.height);
  }
  if (!Number.isFinite(minX)) return { box: { x: 0, y: 0, width: 0, height: 0 }, missing };

  return {
    box: {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    },
    missing,
  };
}

let gfxSeq = 0;
function nextGid(prefix: string, taken: Record<string, unknown>): string {
  let gId: string;
  do {
    gId = `gge_mcp_${prefix}_${++gfxSeq}`;
  } while (gId in taken);
  return gId;
}

export interface DrawResult {
  doc: StdDocument;
  rectGid: string;
  textGid?: string;
  box: Box;
  label?: string;
}

/**
 * Draw a box, optionally with a label above its top-left corner.
 *
 * Y grows downward in EasyEDA's sheet coordinates (values are typically negative), so
 * "above" means a smaller y.
 */
export function drawBox(
  doc: StdDocument,
  box: Box,
  opts: { label?: string; strokeColor?: string; fontSize?: string } = {},
): DrawResult {
  const next = JSON.parse(JSON.stringify(doc)) as StdDocument;
  if (!next.rect) next.rect = {};

  const rectGid = nextGid('rect', next.rect);
  next.rect[rectGid] = {
    x: String(box.x),
    y: String(box.y),
    rx: '',
    ry: '',
    width: String(box.width),
    height: String(box.height),
    strokeColor: opts.strokeColor ?? '#000000',
    strokeWidth: '1',
    strokeStyle: '0',
    fillColor: 'none',
    gId: rectGid,
    locked: '0',
    c_etype: '',
  };

  let textGid: string | undefined;
  if (opts.label) {
    if (!next.annotation) next.annotation = {};
    textGid = nextGid('text', next.annotation);
    next.annotation[textGid] = {
      mark: 'L',
      x: String(box.x + 10),
      y: String(box.y - 10),
      rotation: '0',
      fillColor: '#0000FF',
      fontFamily: '',
      fontSize: opts.fontSize ?? '20pt',
      fontWeight: '',
      fontStyle: '',
      dominantBaseline: '',
      type: 'comment',
      string: opts.label,
      visible: '1',
      textAnchor: 'start',
      gId: textGid,
      locked: '0',
      c_etype: 'pinpart',
    };
  }

  return { doc: next, rectGid, textGid, box, label: opts.label };
}

/** Add a standalone text label at a point. */
export function addText(
  doc: StdDocument,
  at: { x: number; y: number },
  text: string,
  opts: { fontSize?: string; color?: string } = {},
): { doc: StdDocument; gId: string } {
  const next = JSON.parse(JSON.stringify(doc)) as StdDocument;
  if (!next.annotation) next.annotation = {};
  const gId = nextGid('text', next.annotation);
  next.annotation[gId] = {
    mark: 'L',
    x: String(at.x),
    y: String(at.y),
    rotation: '0',
    fillColor: opts.color ?? '#0000FF',
    fontFamily: '',
    fontSize: opts.fontSize ?? '20pt',
    fontWeight: '',
    fontStyle: '',
    dominantBaseline: '',
    type: 'comment',
    string: text,
    visible: '1',
    textAnchor: 'start',
    gId,
    locked: '0',
    c_etype: 'pinpart',
  };
  return { doc: next, gId };
}

/**
 * Verify a graphics edit.
 *
 * Boxes and labels are electrically inert, so the bar is absolute: the netlist must be
 * completely unchanged, and only the expected drawing objects may have appeared.
 */
export function verifyGraphics(
  before: StdDocument,
  after: StdDocument,
  expect: { rects: number; texts: number },
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const count = (d: StdDocument, k: 'rect' | 'annotation') => Object.keys((d[k] ?? {}) as object).length;

  const dRect = count(after, 'rect') - count(before, 'rect');
  const dText = count(after, 'annotation') - count(before, 'annotation');
  if (dRect !== expect.rects) problems.push(`expected ${expect.rects} new rect(s), got ${dRect}`);
  if (dText !== expect.texts) problems.push(`expected ${expect.texts} new label(s), got ${dText}`);

  // Nothing electrical may move.
  const comps = (d: StdDocument) => Object.keys(d.schlib ?? {}).length;
  const wires = (d: StdDocument) => Object.keys(d.wire ?? {}).length;
  if (comps(before) !== comps(after)) problems.push('component count changed — drawing must not touch parts');
  if (wires(before) !== wires(after)) problems.push('wire count changed — drawing must not touch wiring');

  return { ok: problems.length === 0, problems };
}
