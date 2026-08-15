import { listComponents, parseCPara, designatorOrder } from '../model/components.js';
import { buildNetlist, pinNetIndex } from '../model/nets.js';
import { docKind, isSheetFrame, str } from '../model/document.js';
import { renderTable } from './list-components.js';
import type { StdDocument, SchLibEntry } from '../model/types.js';

/** Full detail for one component, including every pin and the net it sits on. */
export function getComponentText(doc: StdDocument, designator: string): string {
  if (docKind(doc) === 'pcb') {
    return 'The active document is a PCB. Component detail is implemented for schematics only in Phase 1.';
  }

  const wanted = designator.trim();
  const comps = listComponents(doc);
  const comp =
    comps.find((c) => c.designator === wanted) ??
    comps.find((c) => c.designator.toLowerCase() === wanted.toLowerCase());

  if (!comp) {
    const near = comps
      .map((c) => c.designator)
      .filter((d) => d.toLowerCase().startsWith(wanted.slice(0, 1).toLowerCase()))
      .slice(0, 15);
    return (
      `No component with designator "${designator}".\n\n` +
      (near.length ? `Similar designators: ${near.join(', ')}\n` : '') +
      `Use easyeda_list_components to see all ${comps.length}.`
    );
  }

  // Locate the raw entry to read pins in document order.
  let entry: SchLibEntry | undefined;
  for (const cid of Object.keys(doc.schlib ?? {})) {
    if (isSheetFrame(cid)) continue;
    if (cid === comp.gId) {
      entry = doc.schlib![cid];
      break;
    }
  }

  const index = pinNetIndex(buildNetlist(doc));

  const lines: string[] = [];
  lines.push(`${comp.designator} — ${comp.name || '(no name)'}`);
  lines.push('');
  const facts: Array<[string, string | undefined]> = [
    ['Footprint', comp.footprint],
    ['Manufacturer', comp.manufacturer],
    ['Manufacturer part', comp.manufacturerPart],
    ['Supplier', comp.supplier],
    ['Supplier part (LCSC)', comp.supplierPart],
    ['JLCPCB part class', comp.partClass],
    ['In BOM', comp.inBom ? 'yes' : 'no'],
    ['Position', comp.x !== undefined ? `x=${comp.x} y=${comp.y}` : undefined],
    ['gId', comp.gId],
  ];
  for (const [k, v] of facts) if (v !== undefined && v !== '') lines.push(`  ${k.padEnd(22)} ${v}`);

  // Any c_para fields not surfaced above, so nothing is silently dropped.
  const para = parseCPara(entry?.head?.c_para);
  const known = new Set([
    'package', 'Supplier', 'Supplier Part', 'Manufacturer', 'Manufacturer Part',
    'JLCPCB Part Class', 'name',
  ]);
  const extra = Object.keys(para).filter((k) => !known.has(k) && para[k] !== '');
  if (extra.length) {
    lines.push('');
    lines.push('  Other attributes:');
    for (const k of extra) lines.push(`    ${k.padEnd(20)} ${para[k]}`);
  }

  const pins = entry?.pin ?? {};
  const pinKeys = Object.keys(pins);
  lines.push('');
  lines.push(`Pins (${pinKeys.length}):`);
  lines.push('');

  const rows = pinKeys
    .map((pk) => {
      const p = pins[pk];
      const numText = str(p?.num?.text) ?? '';
      const net = index.get(`${comp.designator}.${numText}`);
      // A net with only this pin on it is not a connection — every pin creates a
      // graph node whether or not a wire reaches it. Report that as unconnected
      // rather than inventing a net id for it.
      const connected = net !== undefined && net.pins.length > 1;
      return {
        num: numText,
        name: str(p?.name?.text) ?? '',
        net: connected ? net!.name ?? net!.id : '(unconnected)',
        netPins: connected ? net!.pins.length : 0,
      };
    })
    .sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }))
    .map((r) => [r.num || '-', r.name || '-', r.net, r.netPins ? String(r.netPins) : '-']);

  lines.push(renderTable(['Pin', 'Name', 'Net', 'Net pins'], rows));

  const unconnected = rows.filter((r) => r[2] === '(unconnected)').length;
  if (unconnected > 0) {
    lines.push('');
    lines.push(
      `${unconnected} pin(s) are on no net. In this schematic that usually means an ` +
        `unrouted pin or one marked with a no-connect flag.`,
    );
  }
  void designatorOrder;
  return lines.join('\n');
}
