import type { StdDocument, Netlist, Net, NetPin } from './types.js';
import { isSheetFrame, num, str } from './document.js';
import { annotationByMark } from './components.js';

/**
 * Derive the netlist from schematic geometry.
 *
 * EasyEDA Std stores NO explicit netlist (FINDINGS.md §8): wires carry only
 * `pointArr` geometry, pins only a `pinDot` coordinate, and net names live on
 * separate `netflag` objects. Connectivity has to be reconstructed.
 *
 * Two mistakes here produce a netlist that looks entirely plausible and is wrong:
 *
 *  1. Treating a wire as a single segment. Wires are polylines (2..8+ points
 *     observed); only unioning first-to-last silently drops interior connections.
 *  2. Forgetting that same-named netflags are the same net. Global labels are not
 *     wired together — on the reference board GND is 120 separate symbols. Without
 *     the merge pass you get ~156 fragments with GND as 120 one-pin "nets".
 *
 * The diagnostics returned alongside are the guard against both: orphanPins should
 * be 0 (every pin landed on the graph) and nameConflicts should be empty (no net
 * ended up with two names, which would mean an over-merge).
 */

/** Round to 2dp so float noise doesn't split a junction. */
function coordKey(x: unknown, y: unknown): string | null {
  const nx = num(x);
  const ny = num(y);
  if (nx === undefined || ny === undefined) return null;
  return `${Math.round(nx * 100) / 100},${Math.round(ny * 100) / 100}`;
}

class UnionFind {
  private parent = new Map<string, string>();

  find(a: string): string {
    if (!this.parent.has(a)) this.parent.set(a, a);
    let root = a;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression.
    let cur = a;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  keys(): IterableIterator<string> {
    return this.parent.keys();
  }
}

export function buildNetlist(doc: StdDocument): Netlist {
  const uf = new UnionFind();

  // 1. Wires: union every consecutive vertex pair. Polylines, not segments.
  for (const gId of Object.keys(doc.wire ?? {})) {
    const pts = doc.wire![gId]?.pointArr ?? [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = coordKey(pts[i]?.x, pts[i]?.y);
      const b = coordKey(pts[i + 1]?.x, pts[i + 1]?.y);
      if (a && b) uf.union(a, b);
    }
  }

  // 2. Pins attach at pinDot.
  const pinsAt = new Map<string, NetPin[]>();
  let totalPins = 0;
  let attachedPins = 0;

  for (const cid of Object.keys(doc.schlib ?? {})) {
    if (isSheetFrame(cid)) continue;
    const entry = doc.schlib![cid];
    const designator = annotationByMark(entry, 'P') ?? '?';
    for (const pk of Object.keys(entry.pin ?? {})) {
      const pin = entry.pin![pk];
      totalPins++;
      const key = coordKey(pin?.pinDot?.x, pin?.pinDot?.y);
      if (!key) continue;
      uf.find(key); // ensure the node exists even if no wire touches it
      attachedPins++;
      const rec: NetPin = {
        designator,
        pinNumber: str(pin?.num?.text) ?? '',
        pinName: str(pin?.name?.text) ?? '',
      };
      const list = pinsAt.get(key);
      if (list) list.push(rec);
      else pinsAt.set(key, [rec]);
    }
  }

  // 3. Netflags name a node.
  const flagAt = new Map<string, string>();
  for (const fk of Object.keys(doc.netflag ?? {})) {
    const flag = doc.netflag![fk];
    const key = coordKey(flag?.pinDot?.x, flag?.pinDot?.y);
    if (!key) continue;
    const name = str(flag?.mark?.netFlagString);
    if (name === undefined || name === '') continue;
    uf.find(key);
    flagAt.set(key, name);
  }

  // 4. Global labels: same name == same net, even when geometrically disjoint.
  //    This is the step whose absence silently fragments every power net.
  const byName = new Map<string, string[]>();
  for (const [key, name] of flagAt) {
    const list = byName.get(name);
    if (list) list.push(key);
    else byName.set(name, [key]);
  }
  for (const keys of byName.values()) {
    for (let i = 1; i < keys.length; i++) uf.union(keys[0], keys[i]);
  }

  // 5. Collect connected components.
  const groups = new Map<string, { pins: NetPin[]; names: Set<string> }>();
  for (const key of uf.keys()) {
    const root = uf.find(key);
    let g = groups.get(root);
    if (!g) {
      g = { pins: [], names: new Set() };
      groups.set(root, g);
    }
    const p = pinsAt.get(key);
    if (p) g.pins.push(...p);
    const n = flagAt.get(key);
    if (n) g.names.add(n);
  }

  const nameConflicts: string[] = [];
  const nets: Net[] = [];
  let unnamedSeq = 0;

  for (const [root, g] of groups) {
    if (g.pins.length === 0 && g.names.size === 0) continue;
    if (g.names.size > 1) nameConflicts.push([...g.names].sort().join(' | '));
    const name = g.names.size >= 1 ? [...g.names][0] : undefined;
    nets.push({
      id: name ?? `N$${++unnamedSeq}`,
      name,
      pins: g.pins.sort((a, b) =>
        a.designator === b.designator
          ? a.pinNumber.localeCompare(b.pinNumber, undefined, { numeric: true })
          : a.designator.localeCompare(b.designator, undefined, { numeric: true }),
      ),
    });
    void root;
  }

  nets.sort((a, b) => b.pins.length - a.pins.length || a.id.localeCompare(b.id));

  return {
    nets,
    diagnostics: {
      totalPins,
      attachedPins,
      orphanPins: totalPins - attachedPins,
      nameConflicts,
    },
  };
}

/**
 * Index of "DESIGNATOR.PIN" -> net, so a component's pins can be resolved to nets
 * without rescanning. Built from the netlist, not from geometry, so it inherits the
 * same correctness guarantees.
 */
export function pinNetIndex(netlist: Netlist): Map<string, Net> {
  const index = new Map<string, Net>();
  for (const net of netlist.nets) {
    for (const p of net.pins) {
      index.set(`${p.designator}.${p.pinNumber}`, net);
    }
  }
  return index;
}

export function findNet(netlist: Netlist, query: string): Net | undefined {
  const q = query.trim();
  return (
    netlist.nets.find((n) => n.name === q || n.id === q) ??
    netlist.nets.find((n) => (n.name ?? n.id).toLowerCase() === q.toLowerCase())
  );
}
