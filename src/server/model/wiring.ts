import type { StdDocument, Wire } from './types.js';
import { isSheetFrame, num } from './document.js';
import { annotationByMark } from './components.js';
import { buildNetlist } from './nets.js';

/**
 * Creating connections.
 *
 * EasyEDA Std has no netlist, so "connect these two pins" is not a data edit — it is
 * geometry. A wire connects only where its VERTICES coincide with a pin's `pinDot` or
 * another wire's vertex (FINDINGS.md §8). Two wires crossing mid-segment do NOT connect,
 * matching the editor's own behaviour.
 *
 * That cuts both ways:
 *  - a vertex landing on the right coordinate creates the net
 *  - a vertex landing on the WRONG coordinate silently merges two unrelated nets
 *
 * So routing here is deliberately conservative: straight runs and single-corner L shapes
 * only, and any corner that lands on existing geometry is rejected rather than guessed at.
 * Anything that cannot be routed cleanly is refused, not approximated.
 */

export interface PinRef {
  designator: string;
  pinNumber: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface PinLocation extends PinRef {
  point: Point;
}

/** Same rounding the netlist uses, so "coincides" means the same thing everywhere. */
export function coordKey(p: Point): string {
  return `${Math.round(p.x * 100) / 100},${Math.round(p.y * 100) / 100}`;
}

export function findPin(doc: StdDocument, ref: PinRef): PinLocation | undefined {
  const want = ref.designator.trim().toLowerCase();
  for (const gId of Object.keys(doc.schlib ?? {})) {
    if (isSheetFrame(gId)) continue;
    const entry = doc.schlib![gId];
    const d = annotationByMark(entry, 'P');
    if (!d || d.toLowerCase() !== want) continue;
    for (const pk of Object.keys(entry.pin ?? {})) {
      const pin = entry.pin![pk];
      if (String(pin?.num?.text ?? '') !== String(ref.pinNumber)) continue;
      const x = num(pin?.pinDot?.x);
      const y = num(pin?.pinDot?.y);
      if (x === undefined || y === undefined) return undefined;
      return { designator: d, pinNumber: String(ref.pinNumber), point: { x, y } };
    }
  }
  return undefined;
}

/** Every coordinate already occupied by a wire vertex or a pin. */
export function occupiedPoints(doc: StdDocument): Map<string, string> {
  const occupied = new Map<string, string>();
  for (const g of Object.keys(doc.wire ?? {})) {
    for (const p of doc.wire![g]?.pointArr ?? []) {
      const x = num(p.x);
      const y = num(p.y);
      if (x !== undefined && y !== undefined) occupied.set(coordKey({ x, y }), `wire ${g}`);
    }
  }
  for (const gId of Object.keys(doc.schlib ?? {})) {
    if (isSheetFrame(gId)) continue;
    const entry = doc.schlib![gId];
    const d = annotationByMark(entry, 'P') ?? gId;
    for (const pk of Object.keys(entry.pin ?? {})) {
      const pin = entry.pin![pk];
      const x = num(pin?.pinDot?.x);
      const y = num(pin?.pinDot?.y);
      if (x !== undefined && y !== undefined) {
        occupied.set(coordKey({ x, y }), `pin ${d}.${pin?.num?.text ?? '?'}`);
      }
    }
  }
  for (const g of Object.keys(doc.netflag ?? {})) {
    const f = doc.netflag![g];
    const x = num(f?.pinDot?.x);
    const y = num(f?.pinDot?.y);
    if (x !== undefined && y !== undefined) {
      occupied.set(coordKey({ x, y }), `netflag ${f?.mark?.netFlagString ?? '?'}`);
    }
  }
  return occupied;
}

export interface Route {
  points: Point[];
  shape: 'straight' | 'corner';
}

export interface RouteFailure {
  reason: string;
}

/**
 * Route between two pins.
 *
 * Straight when they share a row or column. Otherwise a single right-angle corner,
 * choosing whichever of the two candidate corners is unoccupied. If both corners sit on
 * existing geometry the route is refused — taking one anyway risks merging nets.
 */
export function routeBetween(a: Point, b: Point, occupied: Map<string, string>): Route | RouteFailure {
  if (coordKey(a) === coordKey(b)) {
    return { reason: 'both pins are at the same coordinate — they are already connected' };
  }
  if (a.x === b.x || a.y === b.y) {
    return { points: [a, b], shape: 'straight' };
  }

  const candidates: Point[] = [
    { x: b.x, y: a.y },
    { x: a.x, y: b.y },
  ];
  const blocked: string[] = [];
  for (const corner of candidates) {
    const hit = occupied.get(coordKey(corner));
    if (!hit) return { points: [a, corner, b], shape: 'corner' };
    blocked.push(`(${corner.x},${corner.y}) is occupied by ${hit}`);
  }
  return {
    reason:
      'no clean L-shaped route: both corner options land on existing geometry, and routing ' +
      'through them would merge nets — ' + blocked.join('; '),
  };
}

export function isRouteFailure(r: Route | RouteFailure): r is RouteFailure {
  return (r as RouteFailure).reason !== undefined;
}

let wireSeq = 0;

/** Add a wire to a COPY of the document. Returns the new document and the wire's gId. */
export function addWire(doc: StdDocument, points: Point[]): { doc: StdDocument; gId: string } {
  const next = JSON.parse(JSON.stringify(doc)) as StdDocument;
  if (!next.wire) next.wire = {};
  let gId: string;
  do {
    gId = `gge_mcp_wire_${++wireSeq}`;
  } while (next.wire[gId]);

  const wire: Wire = {
    pointArr: points.map((p) => ({ x: p.x, y: p.y })),
    strokeColor: '#008800',
    strokeWidth: '1',
    strokeStyle: '0',
    fillColor: 'none',
    gId,
    locked: '0',
  };
  next.wire[gId] = wire;
  return { doc: next, gId };
}

export interface ConnectResult {
  doc: StdDocument;
  route: Route;
  gId: string;
  /** The net the two pins ended up on, after the edit. */
  resultingNetPins: string[];
  resultingNetName?: string;
}

export interface ConnectionIntent {
  from: PinLocation;
  to: PinLocation;
}

/**
 * Verify that a wiring edit did exactly what was asked and nothing else.
 *
 * The field-edit verifier (checkIntegrity) asserts topology never moves, which is wrong
 * here — connecting pins is *supposed* to change it. This asserts the specific intended
 * change instead:
 *   - the two pins share a net
 *   - that net gained only those pins (no accidental merge with a passing net)
 *   - every other named net is untouched
 *   - nothing became orphaned and no net acquired a second name
 */
export function verifyConnection(
  before: StdDocument,
  after: StdDocument,
  intent: ConnectionIntent,
): { ok: boolean; problems: string[]; netPins: string[]; netName?: string } {
  const problems: string[] = [];
  const nlBefore = buildNetlist(before);
  const nlAfter = buildNetlist(after);

  const idOf = (p: PinLocation) => `${p.designator}.${p.pinNumber}`;
  const fromId = idOf(intent.from);
  const toId = idOf(intent.to);

  const netOf = (nl: ReturnType<typeof buildNetlist>, id: string) =>
    nl.nets.find((n) => n.pins.some((p) => `${p.designator}.${p.pinNumber}` === id));

  const joined = netOf(nlAfter, fromId);
  if (!joined) {
    return { ok: false, problems: [`${fromId} is not on any net after the edit`], netPins: [] };
  }
  const netPins = joined.pins.map((p) => `${p.designator}.${p.pinNumber}`).sort();
  if (!netPins.includes(toId)) {
    problems.push(`${fromId} and ${toId} are still on different nets — the wire did not connect them`);
  }

  // The joined net should be exactly the union of what the two pins were on before.
  const beforeFrom = netOf(nlBefore, fromId);
  const beforeTo = netOf(nlBefore, toId);
  const expected = new Set<string>();
  for (const n of [beforeFrom, beforeTo]) {
    for (const p of n?.pins ?? []) expected.add(`${p.designator}.${p.pinNumber}`);
  }
  const unexpected = netPins.filter((p) => !expected.has(p));
  if (unexpected.length) {
    problems.push(
      `the new net picked up ${unexpected.length} unintended pin(s): ${unexpected.join(', ')} — ` +
        'the wire merged into existing geometry',
    );
  }

  // Named nets not involved in this connection must be untouched.
  const involved = new Set([beforeFrom?.name, beforeTo?.name].filter(Boolean) as string[]);
  const countsBefore = new Map(nlBefore.nets.filter((n) => n.name).map((n) => [n.name!, n.pins.length]));
  for (const n of nlAfter.nets) {
    if (!n.name || involved.has(n.name)) continue;
    const was = countsBefore.get(n.name);
    if (was === undefined) problems.push(`net "${n.name}" appeared unexpectedly`);
    else if (was !== n.pins.length) problems.push(`unrelated net "${n.name}" changed: ${was} -> ${n.pins.length} pins`);
  }
  for (const [name, count] of countsBefore) {
    if (involved.has(name)) continue;
    if (!nlAfter.nets.some((n) => n.name === name)) problems.push(`net "${name}" disappeared (had ${count} pins)`);
  }

  if (nlAfter.diagnostics.orphanPins > nlBefore.diagnostics.orphanPins) {
    problems.push('pins became orphaned');
  }
  if (nlAfter.diagnostics.nameConflicts.length > nlBefore.diagnostics.nameConflicts.length) {
    problems.push(`net name conflict introduced: ${nlAfter.diagnostics.nameConflicts.join('; ')}`);
  }

  return { ok: problems.length === 0, problems, netPins, netName: joined.name };
}

/** Plan a connection without writing it. */
export function planConnection(
  doc: StdDocument,
  from: PinRef,
  to: PinRef,
): ConnectResult | RouteFailure {
  const a = findPin(doc, from);
  if (!a) return { reason: `pin ${from.designator}.${from.pinNumber} not found` };
  const b = findPin(doc, to);
  if (!b) return { reason: `pin ${to.designator}.${to.pinNumber} not found` };

  const nl = buildNetlist(doc);
  const netOf = (id: string) => nl.nets.find((n) => n.pins.some((p) => `${p.designator}.${p.pinNumber}` === id));
  const na = netOf(`${a.designator}.${a.pinNumber}`);
  const nb = netOf(`${b.designator}.${b.pinNumber}`);
  if (na && nb && na.id === nb.id && na.pins.length > 1) {
    return {
      reason: `${a.designator}.${a.pinNumber} and ${b.designator}.${b.pinNumber} are already on net ${na.name ?? na.id}`,
    };
  }

  const route = routeBetween(a.point, b.point, occupiedPoints(doc));
  if (isRouteFailure(route)) return route;

  const { doc: next, gId } = addWire(doc, route.points);
  const check = verifyConnection(doc, next, { from: a, to: b });
  if (!check.ok) {
    return { reason: `the only available route would corrupt the netlist: ${check.problems.join('; ')}` };
  }
  return { doc: next, route, gId, resultingNetPins: check.netPins, resultingNetName: check.netName };
}

export function isConnectResult(r: ConnectResult | RouteFailure): r is ConnectResult {
  return (r as ConnectResult).doc !== undefined;
}
