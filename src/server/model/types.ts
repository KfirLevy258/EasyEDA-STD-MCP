/** Shapes of the EasyEDA Std document JSON, as observed from a live editor.
 *
 * These are deliberately loose: the document is untyped JSON from a closed-source
 * editor, and fields vary between document versions. Everything is optional and
 * everything is validated at the point of use. See FINDINGS.md §7-§9.
 */

/** A `{gId: object}` map — the shape every collection in the document uses. */
export type GidMap<T = Record<string, unknown>> = Record<string, T>;

/** docType "1" = schematic, "3" = PCB (observed: "1"; PCB inferred, see FINDINGS.md). */
export type DocKind = 'schematic' | 'pcb' | 'unknown';

export interface StdDocument {
  head?: Record<string, unknown>;
  canvas?: Record<string, unknown>;
  BBox?: Record<string, unknown>;
  itemOrder?: Record<string, unknown>;
  /** Schematic: components (plus the sheet frame, see isSheetFrame). */
  schlib?: GidMap<SchLibEntry>;
  wire?: GidMap<Wire>;
  netflag?: GidMap<NetFlag>;
  junction?: GidMap<Record<string, unknown>>;
  /** Sheet-level documentation graphics — no electrical meaning. */
  rect?: GidMap<Record<string, unknown>>;
  annotation?: GidMap<Record<string, unknown>>;
  /** PCB collections. */
  FOOTPRINT?: GidMap<Record<string, unknown>>;
  TRACK?: GidMap<Record<string, unknown>>;
  PAD?: GidMap<Record<string, unknown>>;
  VIA?: GidMap<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface SchLibEntry {
  head?: {
    x?: number | string;
    y?: number | string;
    /** Backtick-delimited key`value` string — parse with parseCPara(). */
    c_para?: string;
    gId?: string;
    uuid?: string;
    /** "yes" | "no" — excluded from BOM when "no". */
    add_into_bom?: string;
    bind_pcb_id?: string;
    [key: string]: unknown;
  };
  /** Designator and value live here as text shapes, keyed by `mark`. */
  annotation?: GidMap<Annotation>;
  pin?: GidMap<Pin>;
  [key: string]: unknown;
}

export interface Annotation {
  /** "P" = designator, "N" = name/value. */
  mark?: string;
  string?: string;
  visible?: string;
  [key: string]: unknown;
}

export interface Pin {
  configure?: { x?: number | string; y?: number | string; gId?: string; [k: string]: unknown };
  /** The electrical connection point. */
  pinDot?: { x?: number | string; y?: number | string };
  name?: { text?: string; [k: string]: unknown };
  num?: { text?: string; [k: string]: unknown };
  [key: string]: unknown;
}

export interface Wire {
  /** Polyline, 2..8+ points observed. NOT a single segment. */
  pointArr?: Array<{ x?: number | string; y?: number | string }>;
  gId?: string;
  [key: string]: unknown;
}

export interface NetFlag {
  pinDot?: { x?: number | string; y?: number | string };
  mark?: {
    /** The net name, e.g. "GND". Note: netFlagString, not `text`. */
    netFlagString?: string;
    [k: string]: unknown;
  };
  configure?: { partId?: string; [k: string]: unknown };
  [key: string]: unknown;
}

/** A component resolved from a schlib entry. */
export interface Component {
  gId: string;
  designator: string;
  name: string;
  /** Parsed from c_para. */
  footprint?: string;
  supplier?: string;
  supplierPart?: string;
  manufacturer?: string;
  manufacturerPart?: string;
  partClass?: string;
  inBom: boolean;
  x?: number;
  y?: number;
  pinCount: number;
}

export interface NetPin {
  designator: string;
  pinNumber: string;
  pinName: string;
}

export interface Net {
  /** Stable synthesised id — most nets are unnamed. */
  id: string;
  /** Name from a netflag, when one exists. */
  name?: string;
  pins: NetPin[];
}

export interface Netlist {
  nets: Net[];
  /** Health checks — see FINDINGS.md §8. Non-zero values mean the extraction is suspect. */
  diagnostics: {
    totalPins: number;
    attachedPins: number;
    orphanPins: number;
    nameConflicts: string[];
  };
}
