import type { StdDocument, SchLibEntry, Component } from './types.js';
import { isSheetFrame, num, str } from './document.js';

/**
 * `c_para` is a backtick-delimited key`value` string, NOT an object. FINDINGS.md §9:
 *
 *   package`SOT-23-5`Supplier`LCSC`Supplier Part`C0000000`Manufacturer`ACME`...
 *
 * Trailing backtick is normal. Values may be empty. Keys may repeat (last wins).
 */
export function parseCPara(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'string' || raw.length === 0) return out;
  const parts = raw.split('`');
  // Pairs: [key, value, key, value, ...]. A trailing lone key is ignored.
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const k = parts[i]?.trim();
    if (!k) continue;
    out[k] = parts[i + 1] ?? '';
  }
  return out;
}

/**
 * Designator and value are text shapes in `annotation`, keyed by `mark`:
 * "P" = designator, "N" = name/value. FINDINGS.md §9.
 */
export function annotationByMark(entry: SchLibEntry, mark: string): string | undefined {
  const anns = entry.annotation;
  if (!anns) return undefined;
  for (const gId of Object.keys(anns)) {
    const a = anns[gId];
    if (a && a.mark === mark) {
      const s = str(a.string);
      if (s !== undefined && s !== '') return s;
    }
  }
  return undefined;
}

export function toComponent(gId: string, entry: SchLibEntry): Component {
  const head = entry.head ?? {};
  const para = parseCPara(head.c_para);

  return {
    gId,
    designator: annotationByMark(entry, 'P') ?? '?',
    name: annotationByMark(entry, 'N') ?? para['name'] ?? '',
    footprint: para['package'] || undefined,
    supplier: para['Supplier'] || undefined,
    supplierPart: para['Supplier Part'] || undefined,
    manufacturer: para['Manufacturer'] || undefined,
    manufacturerPart: para['Manufacturer Part'] || undefined,
    partClass: para['JLCPCB Part Class'] || undefined,
    // Absent means included; only an explicit "no" excludes it.
    inBom: str(head.add_into_bom) !== 'no',
    x: num(head.x),
    y: num(head.y),
    pinCount: entry.pin ? Object.keys(entry.pin).length : 0,
  };
}

/** All real components, sheet frame excluded. */
export function listComponents(doc: StdDocument): Component[] {
  const schlib = doc.schlib;
  if (!schlib) return [];
  const out: Component[] = [];
  for (const gId of Object.keys(schlib)) {
    if (isSheetFrame(gId)) continue;
    out.push(toComponent(gId, schlib[gId]));
  }
  return out.sort((a, b) => designatorOrder(a.designator, b.designator));
}

/** Sort R1, R2, R10 naturally rather than R1, R10, R2. */
export function designatorOrder(a: string, b: string): number {
  const m = /^([A-Za-z_]*)(\d*)/;
  const [, ap = '', an = ''] = a.match(m) ?? [];
  const [, bp = '', bn = ''] = b.match(m) ?? [];
  if (ap !== bp) return ap.localeCompare(bp);
  if (an && bn) return Number(an) - Number(bn);
  return a.localeCompare(b);
}
