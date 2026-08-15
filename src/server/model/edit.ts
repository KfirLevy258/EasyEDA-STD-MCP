import type { StdDocument, SchLibEntry } from './types.js';
import { isSheetFrame } from './document.js';
import { parseCPara, annotationByMark, listComponents } from './components.js';
import { buildNetlist } from './nets.js';

/**
 * Pure document edits. Nothing here talks to the editor — each function takes a
 * document and returns a NEW document plus a description of what changed, so the
 * change can be previewed, tested offline, and diffed before anything is written.
 */

export interface FieldChange {
  designator: string;
  field: EditableField;
  from: string;
  to: string;
}

export type EditableField = 'value' | 'designator' | 'footprint' | 'lcsc' | 'manufacturer' | 'manufacturerPart';

/** Re-encode a c_para map back to EasyEDA's backtick form. Order is preserved. */
export function encodeCPara(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}\`${v}\``)
    .join('');
}

const CPARA_KEY: Partial<Record<EditableField, string>> = {
  footprint: 'package',
  lcsc: 'Supplier Part',
  manufacturer: 'Manufacturer',
  manufacturerPart: 'Manufacturer Part',
};

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Locate a component's schlib gId by designator. */
export function findComponentGid(doc: StdDocument, designator: string): string | undefined {
  const want = designator.trim().toLowerCase();
  for (const gId of Object.keys(doc.schlib ?? {})) {
    if (isSheetFrame(gId)) continue;
    const d = annotationByMark(doc.schlib![gId], 'P');
    if (d && d.toLowerCase() === want) return gId;
  }
  return undefined;
}

function setAnnotation(entry: SchLibEntry, mark: string, value: string): string | undefined {
  const anns = entry.annotation ?? {};
  for (const k of Object.keys(anns)) {
    if (anns[k]?.mark === mark) {
      const prev = String(anns[k].string ?? '');
      anns[k].string = value;
      return prev;
    }
  }
  return undefined;
}

/**
 * Apply field edits to a document. Returns a new document and the changes made.
 * Edits that would be a no-op are dropped rather than written.
 */
export function applyFieldEdits(
  doc: StdDocument,
  edits: Array<{ designator: string; field: EditableField; value: string }>,
): { doc: StdDocument; changes: FieldChange[]; errors: string[] } {
  const next = deepClone(doc);
  const changes: FieldChange[] = [];
  const errors: string[] = [];

  for (const edit of edits) {
    const gId = findComponentGid(next, edit.designator);
    if (!gId) {
      errors.push(`no component with designator "${edit.designator}"`);
      continue;
    }
    const entry = next.schlib![gId];

    if (edit.field === 'value' || edit.field === 'designator') {
      const mark = edit.field === 'value' ? 'N' : 'P';
      const prev = setAnnotation(entry, mark, edit.value);
      if (prev === undefined) {
        errors.push(`${edit.designator}: no ${edit.field} annotation to update`);
        continue;
      }
      if (prev !== edit.value) {
        changes.push({ designator: edit.designator, field: edit.field, from: prev, to: edit.value });
      }
      continue;
    }

    const key = CPARA_KEY[edit.field];
    if (!key) {
      errors.push(`${edit.designator}: field "${edit.field}" is not editable`);
      continue;
    }
    const head = entry.head ?? (entry.head = {});
    const para = parseCPara(head.c_para);
    const prev = para[key] ?? '';
    if (prev !== edit.value) {
      para[key] = edit.value;
      // Setting an LCSC part implies a supplier; without it EasyEDA shows no source.
      if (edit.field === 'lcsc' && edit.value && !para['Supplier']) para['Supplier'] = 'LCSC';
      head.c_para = encodeCPara(para);
      changes.push({ designator: edit.designator, field: edit.field, from: prev, to: edit.value });
    }
  }

  return { doc: next, changes, errors };
}

export interface IntegrityReport {
  ok: boolean;
  problems: string[];
  before: IntegritySnapshot;
  after: IntegritySnapshot;
}

export interface IntegritySnapshot {
  components: number;
  pins: number;
  wires: number;
  wireVertices: number;
  nets: number;
  namedNets: Record<string, number>;
  orphanPins: number;
  nameConflicts: number;
}

export function snapshot(doc: StdDocument): IntegritySnapshot {
  const nl = buildNetlist(doc);
  const named: Record<string, number> = {};
  for (const n of nl.nets) if (n.name) named[n.name] = n.pins.length;
  let wireVertices = 0;
  for (const g of Object.keys(doc.wire ?? {})) wireVertices += (doc.wire![g]?.pointArr ?? []).length;

  return {
    components: listComponents(doc).length,
    pins: nl.diagnostics.totalPins,
    wires: Object.keys(doc.wire ?? {}).length,
    wireVertices,
    nets: nl.nets.length,
    namedNets: named,
    orphanPins: nl.diagnostics.orphanPins,
    nameConflicts: nl.diagnostics.nameConflicts.length,
  };
}

/**
 * Compare structural integrity before and after an edit.
 *
 * Field edits must never change topology. If any of these move, the write did
 * something it was not asked to and should be rolled back.
 */
export function checkIntegrity(before: StdDocument, after: StdDocument): IntegrityReport {
  const b = snapshot(before);
  const a = snapshot(after);
  const problems: string[] = [];

  const compare: Array<[string, number, number]> = [
    ['component count', b.components, a.components],
    ['pin count', b.pins, a.pins],
    ['wire count', b.wires, a.wires],
    ['wire vertices', b.wireVertices, a.wireVertices],
    ['net count', b.nets, a.nets],
  ];
  for (const [label, x, y] of compare) {
    if (x !== y) problems.push(`${label} changed: ${x} -> ${y}`);
  }
  if (a.orphanPins > b.orphanPins) problems.push(`orphan pins increased: ${b.orphanPins} -> ${a.orphanPins}`);
  if (a.nameConflicts > b.nameConflicts) problems.push(`net name conflicts appeared: ${a.nameConflicts}`);

  for (const [name, count] of Object.entries(b.namedNets)) {
    const now = a.namedNets[name];
    if (now === undefined) problems.push(`net "${name}" disappeared`);
    else if (now !== count) problems.push(`net "${name}" pin count changed: ${count} -> ${now}`);
  }

  return { ok: problems.length === 0, problems, before: b, after: a };
}
