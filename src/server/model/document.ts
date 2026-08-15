import type { StdDocument, DocKind, GidMap } from './types.js';

/** The sheet frame lives in `schlib` but is not a component. FINDINGS.md §9. */
export function isSheetFrame(gId: string): boolean {
  return gId.startsWith('frame_lib') || gId.startsWith('frame');
}

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return String(v);
}

/**
 * Classify the document. `head.docType` is "1" for schematic (observed on a real
 * board). PCB is identified structurally rather than by docType, because the PCB
 * docType value has not been confirmed against a live document.
 */
export function docKind(doc: StdDocument | null | undefined): DocKind {
  if (!doc || typeof doc !== 'object') return 'unknown';
  const dt = str(doc.head?.['docType']);
  if (dt === '1') return 'schematic';
  // Structural fallbacks — trust shape over an unverified magic number.
  if (doc.schlib || doc.wire) return 'schematic';
  if (doc.FOOTPRINT || doc.TRACK || doc.PAD) return 'pcb';
  if (dt === '3' || dt === '5') return 'pcb';
  return 'unknown';
}

/** Every top-level key that is a `{gId: object}` collection, with its size. */
export function collectionCounts(doc: StdDocument): Array<{ name: string; count: number }> {
  const out: Array<{ name: string; count: number }> = [];
  for (const key of Object.keys(doc)) {
    const v = (doc as Record<string, unknown>)[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push({ name: key, count: Object.keys(v as GidMap).length });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Rough byte size of the document, for size guards and reporting. */
export function approxBytes(doc: unknown): number {
  try {
    return JSON.stringify(doc).length;
  } catch {
    return -1;
  }
}

export function documentName(doc: StdDocument): string | undefined {
  const head = doc.head as Record<string, unknown> | undefined;
  return str(head?.['title']) ?? str(head?.['docTitle']);
}
