/**
 * Generate `synthetic-sch.json` — a public EasyEDA Std schematic with no real design
 * data in it. Used by the portable test suite and by the README examples.
 *
 *   node test/fixtures/make-synthetic.mjs
 *
 * It is a plausible little I2C sensor node (regulator, MCU, sensor, connector), sized
 * so the tool output looks like real work rather than a toy. Every part name is
 * invented; any resemblance to a real LCSC part number is coincidental.
 *
 * It deliberately reproduces the awkward cases found on real boards:
 *   - a sheet frame in `schlib` that is NOT a component
 *   - `c_para` as a backtick-delimited string, incl. a part with no LCSC number
 *   - designator/value as `annotation` text shapes keyed by mark P/N
 *   - multi-point polyline wires (not just 2-point segments)
 *   - the same net name on many disjoint netflags (global label merge)
 *   - unconnected pins (single-pin groups)
 *   - a component marked add_into_bom=no
 *   - the same value in two different packages (must not merge in the BOM)
 *   - a component with zero pins
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let gid = 0;
const nextGid = () => `gge${++gid}`;

const cpara = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}\`${v}\``)
    .join('');

function component({ designator, value, footprint, lcsc, mfr, mpn, x, y, pins, inBom = true }) {
  const annotation = {
    [nextGid()]: { mark: 'N', string: value, type: 'comment', visible: '1', x: String(x), y: String(y - 40) },
    [nextGid()]: { mark: 'P', string: designator, type: 'comment', visible: '1', x: String(x + 60), y: String(y - 40) },
  };
  const pin = {};
  for (const p of pins) {
    pin[nextGid()] = {
      configure: { display: 'show', electric: '0', x: p.x, y: p.y, rotation: '0', gId: nextGid(), locked: '0' },
      pinDot: { x: p.x, y: p.y },
      name: { visible: '1', text: p.name, x: String(p.x), y: String(p.y) },
      num: { visible: '1', text: p.num, x: String(p.x), y: String(p.y) },
      dot: { visible: '0', x: String(p.x), y: String(p.y) },
    };
  }
  return {
    head: {
      x, y,
      c_para: cpara({
        package: footprint,
        Supplier: lcsc ? 'LCSC' : undefined,
        'Supplier Part': lcsc,
        Manufacturer: mfr,
        'Manufacturer Part': mpn,
        Contributor: 'synthetic',
      }),
      rotation: '', importFlag: '0',
      gId: `sch${designator}`, uuid: `uuid-${designator}`, locked: '0',
      add_into_bom: inBom ? 'yes' : 'no', convert_to_pcb: 'yes',
    },
    itemOrder: {}, annotation, pin,
  };
}

const wire = (points) => ({
  pointArr: points.map(([x, y]) => ({ x, y })),
  strokeColor: '#008800', strokeWidth: '1', strokeStyle: '0', fillColor: 'none',
  gId: nextGid(), locked: '0',
});

const netflag = (name, x, y) => ({
  configure: {
    partId: name === 'GND' ? 'part_netLabel_gnD' : 'part_netLabel_netPort',
    x, y, rotation: '0', gId: nextGid(), locked: '0',
  },
  pinDot: { x, y },
  mark: { netFlagString: name, fillColor: '#0000FF', x: String(x - 20), y: String(y), visible: 1, gId: nextGid() },
  shapes: {},
});

/* ---- a small I2C sensor node ------------------------------------------------
 *  J1 (USB-ish header) -> U1 LDO -> +3V3 rail
 *  U2 MCU on +3V3, I2C to U3 sensor, pull-ups R1/R2 on SDA/SCL
 *  D1 status LED via R3;  Y1 crystal on the MCU
 *  Decoupling caps to GND everywhere (GND via many disjoint flags)
 * --------------------------------------------------------------------------- */

const schlib = {
  // Sheet frame: in schlib, but NOT a component.
  frame_lib_1: {
    head: { x: 0, y: 0, c_para: 'name`frame`', gId: 'frame_lib_1' },
    itemOrder: {}, annotation: {}, path: {}, rect: {}, polyline: {},
  },

  schJ1: component({
    designator: 'J1', value: 'CONN-4P', footprint: 'HDR-4P-P2.54', lcsc: 'C7001001',
    mfr: 'GenericConn', mpn: 'GC-HDR4', x: 100, y: -100,
    pins: [
      { num: '1', name: 'VBUS', x: 140, y: -80 },
      { num: '2', name: 'GND', x: 140, y: -120 },
      { num: '3', name: 'SDA', x: 140, y: -160 },
      { num: '4', name: 'SCL', x: 140, y: -200 },
    ],
  }),

  schU1: component({
    designator: 'U1', value: 'LDO33-A', footprint: 'SOT-23-5', lcsc: 'C7001002',
    mfr: 'GenericSemi', mpn: 'GS-LDO33A', x: 320, y: -80,
    pins: [
      { num: '1', name: 'IN', x: 280, y: -80 },
      { num: '2', name: 'GND', x: 300, y: -40 },
      { num: '3', name: 'EN', x: 280, y: -120 },
      { num: '4', name: 'NC', x: 360, y: -120 },   // unconnected
      { num: '5', name: 'OUT', x: 360, y: -80 },
    ],
  }),

  schU2: component({
    designator: 'U2', value: 'MCU32-A', footprint: 'QFN-24_L4.0-W4.0-P0.50', lcsc: 'C7001003',
    mfr: 'GenericSemi', mpn: 'GS-MCU32A', x: 620, y: -160,
    pins: [
      { num: '1', name: 'VDD', x: 580, y: -100 },
      { num: '2', name: 'GND', x: 580, y: -140 },
      { num: '3', name: 'SDA', x: 580, y: -180 },
      { num: '4', name: 'SCL', x: 580, y: -220 },
      { num: '5', name: 'XIN', x: 700, y: -180 },
      { num: '6', name: 'XOUT', x: 700, y: -220 },
      { num: '7', name: 'LED', x: 700, y: -100 },
      { num: '8', name: 'RESET', x: 700, y: -140 },  // unconnected
    ],
  }),

  schU3: component({
    designator: 'U3', value: 'TEMP-SENS-A', footprint: 'DFN-6_L2.0-W2.0-P0.65', lcsc: 'C7001004',
    mfr: 'GenericSemi', mpn: 'GS-TS100', x: 900, y: -180,
    pins: [
      { num: '1', name: 'VDD', x: 860, y: -140 },
      { num: '2', name: 'GND', x: 860, y: -260 },
      { num: '3', name: 'SDA', x: 860, y: -180 },
      { num: '4', name: 'SCL', x: 860, y: -220 },
    ],
  }),

  schY1: component({
    designator: 'Y1', value: '16MHz', footprint: 'CRYSTAL-SMD-3225', lcsc: 'C7001005',
    mfr: 'GenericXtal', mpn: 'GX-16M', x: 780, y: -200,
    pins: [
      { num: '1', name: '1', x: 760, y: -180 },
      { num: '2', name: '2', x: 760, y: -220 },
    ],
  }),

  schD1: component({
    designator: 'D1', value: 'LED-GRN', footprint: 'LED-0603', lcsc: 'C7001006',
    mfr: 'GenericOpto', mpn: 'GO-LG06', x: 820, y: -80,
    pins: [
      { num: '1', name: 'A', x: 800, y: -100 },
      { num: '2', name: 'K', x: 860, y: -100 },
    ],
  }),
};

// Decoupling: four 100nF/C0402 (same part), two 10uF/C0805.
const caps = [
  { d: 'C1', v: '100nF', f: 'C0402', l: 'C7002001', x: 250, hi: [250, -80] },
  { d: 'C2', v: '100nF', f: 'C0402', l: 'C7002001', x: 430, hi: [430, -80] },
  { d: 'C3', v: '100nF', f: 'C0402', l: 'C7002001', x: 500, hi: [500, -80] },
  { d: 'C4', v: '100nF', f: 'C0402', l: 'C7002001', x: 940, hi: [940, -140] },
  { d: 'C5', v: '10uF', f: 'C0805', l: 'C7002002', x: 200, hi: [200, -80] },
  { d: 'C6', v: '10uF', f: 'C0805', l: 'C7002002', x: 470, hi: [470, -80] },
];
for (const c of caps) {
  schlib['sch' + c.d] = component({
    designator: c.d, value: c.v, footprint: c.f, lcsc: c.l,
    mfr: 'GenericPassive', mpn: `GP-${c.v}-${c.f}`, x: c.x, y: -60,
    pins: [
      { num: '1', name: '1', x: c.hi[0], y: c.hi[1] },
      { num: '2', name: '2', x: c.hi[0], y: -40 },
    ],
  });
}

// Resistors: 10k in TWO packages (must not merge), plus a 1k for the LED.
const res = [
  { d: 'R1', v: '10kΩ', f: 'R0402', l: 'C7003001', a: [540, -180], b: [540, -80] },
  { d: 'R2', v: '10kΩ', f: 'R0402', l: 'C7003001', a: [540, -220], b: [520, -80] },
  { d: 'R3', v: '1kΩ', f: 'R0402', l: 'C7003002', a: [740, -100], b: [800, -100] },
  { d: 'R4', v: '10kΩ', f: 'R0603', l: 'C7003003', a: [980, -220], b: [980, -300] },
];
for (const r of res) {
  schlib['sch' + r.d] = component({
    designator: r.d, value: r.v, footprint: r.f, lcsc: r.l,
    mfr: 'GenericPassive', mpn: `GP-${r.v}-${r.f}`, x: r.a[0], y: r.a[1],
    pins: [
      { num: '1', name: '1', x: r.a[0], y: r.a[1] },
      { num: '2', name: '2', x: r.b[0], y: r.b[1] },
    ],
  });
}

// A mounting hole: no LCSC part, and excluded from the BOM.
schlib.schH1 = component({
  designator: 'H1', value: 'MountingHole', footprint: 'HOLE-M3', lcsc: '', x: 100, y: -320,
  inBom: false,
  pins: [{ num: '1', name: '1', x: 100, y: -320 }],   // unconnected
});

// A test point with no pins at all.
schlib.schTP1 = component({
  designator: 'TP1', value: 'TestPoint', footprint: 'TP-1.0', lcsc: 'C7004001',
  mfr: 'GenericTP', mpn: 'GT-TP10', x: 180, y: -320, pins: [],
});

const doc = {
  head: {
    docType: '1', editorVersion: '6.5.51', newgId: 'true', c_para: '',
    hasIdFlag: 'true', x: '0', y: '0',
  },
  canvas: { viewWidth: 1400, viewHeight: 900, backGround: '#FFFFFF', gridSize: 10 },
  BBox: { x: 0, y: -400, width: 1100, height: 400 },
  itemOrder: {}, colors: {}, importFlag: 0,
  schlib,

  wire: {
    // VBUS: J1.1 -> U1.1, cornered polyline through the C5 tap.
    [nextGid()]: wire([[140, -80], [200, -80], [250, -80], [280, -80]]),
    // +3V3 rail: U1.5 -> caps -> U2.1 -> U3.1, several corners.
    [nextGid()]: wire([[360, -80], [430, -80], [470, -80], [500, -80], [580, -100]]),
    [nextGid()]: wire([[580, -100], [520, -80], [540, -80]]),
    [nextGid()]: wire([[580, -100], [860, -140], [940, -140]]),
    // I2C SDA: J1.3 -> R1 -> U2.3 -> U3.3
    [nextGid()]: wire([[140, -160], [540, -180], [580, -180]]),
    [nextGid()]: wire([[580, -180], [860, -180]]),
    // I2C SCL: J1.4 -> R2 -> U2.4 -> U3.4 -> R4
    [nextGid()]: wire([[140, -200], [540, -220], [580, -220]]),
    [nextGid()]: wire([[580, -220], [860, -220], [980, -220]]),
    // Crystal
    [nextGid()]: wire([[700, -180], [760, -180]]),
    [nextGid()]: wire([[700, -220], [760, -220]]),
    // LED chain: U2.7 -> R3 -> D1.A ; D1.K -> GND
    [nextGid()]: wire([[700, -100], [740, -100]]),
    [nextGid()]: wire([[860, -100], [860, -60]]),
    // Enable tied to the rail
    [nextGid()]: wire([[280, -120], [250, -120], [250, -80]]),
    // GND stubs down to each flag
    [nextGid()]: wire([[140, -120], [140, -40]]),
    [nextGid()]: wire([[300, -40], [300, -20]]),
    [nextGid()]: wire([[580, -140], [580, -40]]),
    [nextGid()]: wire([[860, -260], [860, -280]]),
    [nextGid()]: wire([[980, -300], [980, -320]]),
  },

  netflag: {
    // Many disjoint GND symbols that are electrically one net.
    [nextGid()]: netflag('GND', 140, -40),
    [nextGid()]: netflag('GND', 300, -20),
    [nextGid()]: netflag('GND', 580, -40),
    [nextGid()]: netflag('GND', 860, -280),
    [nextGid()]: netflag('GND', 980, -320),
    [nextGid()]: netflag('GND', 860, -60),
    [nextGid()]: netflag('GND', 200, -40),
    [nextGid()]: netflag('GND', 250, -40),
    [nextGid()]: netflag('GND', 430, -40),
    [nextGid()]: netflag('GND', 470, -40),
    [nextGid()]: netflag('GND', 500, -40),
    [nextGid()]: netflag('GND', 940, -40),
    // Named rails and signals.
    [nextGid()]: netflag('+3V3', 500, -80),
    [nextGid()]: netflag('VBUS', 200, -80),
    [nextGid()]: netflag('SDA', 540, -180),
    [nextGid()]: netflag('SCL', 540, -220),
  },

  junction: {}, noconnectflag: {}, rect: {}, annotation: {}, image: {},
};

// Cap low sides sit directly on GND flag coordinates, so they need no extra wire.
// (An earlier version ran a wire from C4.1 to C4.2, which shorted +3V3 to GND —
// the netlist's nameConflicts check caught it.)

const out = resolve(here, 'synthetic-sch.json');
writeFileSync(out, JSON.stringify(doc, null, 1));
console.log(`wrote ${out}`);
