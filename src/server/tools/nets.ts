import { buildNetlist, findNet } from '../model/nets.js';
import { docKind } from '../model/document.js';
import { renderTable } from './list-components.js';
import type { StdDocument } from '../model/types.js';

const DEFAULT_LIMIT = 100;

/** Warn loudly if the extraction looks unsound — a wrong netlist is worse than none. */
function healthWarnings(doc: StdDocument): string[] {
  const { diagnostics } = buildNetlist(doc);
  const warn: string[] = [];
  if (diagnostics.orphanPins > 0) {
    warn.push(
      `WARNING: ${diagnostics.orphanPins} of ${diagnostics.totalPins} pins could not be placed ` +
        `on the connectivity graph. This netlist is incomplete — treat it as unreliable.`,
    );
  }
  if (diagnostics.nameConflicts.length > 0) {
    warn.push(
      `WARNING: ${diagnostics.nameConflicts.length} net(s) resolved to more than one name ` +
        `(${diagnostics.nameConflicts.slice(0, 3).join('; ')}). Nets may have been merged incorrectly.`,
    );
  }
  return warn;
}

export function listNetsText(
  doc: StdDocument,
  opts: { filter?: string; limit?: number; namedOnly?: boolean; includeUnconnected?: boolean } = {},
): string {
  if (docKind(doc) === 'pcb') {
    return 'The active document is a PCB. Net listing is implemented for schematics only in Phase 1.';
  }
  const netlist = buildNetlist(doc);
  // A group holding a single pin is an unconnected pin, not a net. Every pin creates
  // a graph node whether or not a wire reaches it, so these appear naturally and
  // would otherwise swamp the listing.
  const singlePin = netlist.nets.filter((n) => n.pins.length === 1 && !n.name).length;
  let nets = opts.includeUnconnected
    ? netlist.nets
    : netlist.nets.filter((n) => n.pins.length > 1 || !!n.name);
  const total = nets.length;

  if (opts.namedOnly) nets = nets.filter((n) => n.name);
  if (opts.filter) {
    const q = opts.filter.toLowerCase();
    nets = nets.filter((n) => (n.name ?? n.id).toLowerCase().includes(q));
  }
  const matched = nets.length;
  if (matched === 0) {
    return `No nets match${opts.filter ? ` "${opts.filter}"` : ''} (${total} nets in this schematic).`;
  }

  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const shown = nets.slice(0, limit);

  const rows = shown.map((n) => [
    n.name ?? n.id,
    n.name ? 'named' : 'local',
    String(n.pins.length),
    n.pins.slice(0, 5).map((p) => `${p.designator}.${p.pinNumber}`).join(' ') +
      (n.pins.length > 5 ? ` +${n.pins.length - 5}` : ''),
  ]);

  const namedCount = nets.filter((n) => n.name).length;
  const notes = [
    `${total} nets (${namedCount} named, ${total - namedCount} unnamed local nets).`,
    singlePin > 0 && !opts.includeUnconnected
      ? `${singlePin} unconnected pin(s) excluded; pass includeUnconnected to see them.`
      : '',
    opts.filter || opts.namedOnly ? `${matched} shown after filtering.` : '',
    matched > limit ? `Showing the first ${limit}; raise \`limit\` for more.` : '',
  ].filter(Boolean);

  const out = [
    ...healthWarnings(doc),
    notes.join(' '),
    '',
    renderTable(['Net', 'Kind', 'Pins', 'Connections'], rows),
  ];

  // Only explain synthesised ids when some are actually on screen.
  if (shown.some((n) => !n.name)) {
    out.push(
      '',
      'Unnamed nets use synthesised ids (N$1, N$2, ...). These are stable within a single',
      'reading of the document but WILL change if the schematic is edited — do not store them.',
    );
  }
  return out.join('\n');
}

export function traceNetText(doc: StdDocument, netQuery: string): string {
  if (docKind(doc) === 'pcb') {
    return 'The active document is a PCB. Net tracing is implemented for schematics only in Phase 1.';
  }
  const netlist = buildNetlist(doc);
  const net = findNet(netlist, netQuery);

  if (!net) {
    const suggestions = netlist.nets
      .filter((n) => n.name)
      .slice(0, 12)
      .map((n) => n.name!)
      .join(', ');
    return (
      `No net named "${netQuery}".\n\n` +
      `Named nets in this schematic: ${suggestions || '(none)'}\n` +
      `Use easyeda_list_nets to see all ${netlist.nets.length} nets, including unnamed ones.`
    );
  }

  // Resolve owning component names for context.
  const bySchlib = new Map<string, string>();
  for (const cid of Object.keys(doc.schlib ?? {})) {
    const entry = doc.schlib![cid];
    const anns = entry.annotation ?? {};
    let desig = '';
    let name = '';
    for (const ak of Object.keys(anns)) {
      const a = anns[ak];
      if (a?.mark === 'P') desig = String(a.string ?? '');
      if (a?.mark === 'N') name = String(a.string ?? '');
    }
    if (desig) bySchlib.set(desig, name);
  }

  const rows = net.pins.map((p) => [
    p.designator,
    p.pinNumber,
    p.pinName || '-',
    bySchlib.get(p.designator) || '-',
  ]);

  return [
    ...healthWarnings(doc),
    `Net ${net.name ?? net.id}${net.name ? '' : ' (unnamed local net)'} — ${net.pins.length} connection(s).`,
    '',
    renderTable(['Designator', 'Pin', 'Pin name', 'Component'], rows),
  ].join('\n');
}
