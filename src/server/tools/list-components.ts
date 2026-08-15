import { listComponents } from '../model/components.js';
import { docKind } from '../model/document.js';
import type { StdDocument, Component } from '../model/types.js';

export interface ListComponentsOptions {
  /** Case-insensitive substring match across designator, name, footprint and part numbers. */
  filter?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 200;

/**
 * Summarise components as a compact table. Never returns raw document JSON —
 * a real board is ~888 KB (FINDINGS.md §10).
 */
export function listComponentsText(doc: StdDocument, opts: ListComponentsOptions = {}): string {
  const kind = docKind(doc);
  if (kind === 'pcb') {
    return 'The active document is a PCB. Component listing is implemented for schematics only in Phase 1.';
  }

  let comps = listComponents(doc);
  const total = comps.length;

  if (opts.filter) {
    const q = opts.filter.toLowerCase();
    comps = comps.filter((c) => matches(c, q));
  }
  const matched = comps.length;

  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const truncated = matched > limit;
  const shown = comps.slice(0, limit);

  if (matched === 0) {
    return opts.filter
      ? `No components match "${opts.filter}" (${total} components in this schematic).`
      : 'No components found in this schematic.';
  }

  const rows = shown.map((c) => [
    c.designator,
    c.name || '-',
    c.footprint || '-',
    c.supplierPart || '-',
    String(c.pinCount),
  ]);
  const header = ['Designator', 'Name', 'Footprint', 'LCSC', 'Pins'];
  const table = renderTable(header, rows);

  const notes: string[] = [];
  notes.push(
    opts.filter
      ? `${matched} of ${total} components match "${opts.filter}".`
      : `${total} components.`,
  );
  if (truncated) {
    notes.push(`Showing the first ${limit}. Narrow with \`filter\`, or raise \`limit\`.`);
  }
  const excluded = shown.filter((c) => !c.inBom).length;
  if (excluded > 0) {
    notes.push(`${excluded} shown component(s) are marked not-in-BOM.`);
  }

  return `${notes.join(' ')}\n\n${table}`;
}

function matches(c: Component, q: string): boolean {
  return (
    c.designator.toLowerCase().includes(q) ||
    c.name.toLowerCase().includes(q) ||
    (c.footprint ?? '').toLowerCase().includes(q) ||
    (c.supplierPart ?? '').toLowerCase().includes(q) ||
    (c.manufacturerPart ?? '').toLowerCase().includes(q) ||
    (c.manufacturer ?? '').toLowerCase().includes(q)
  );
}

export function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}
