#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { Bridge } from './bridge.js';
import { doctor } from './tools/doctor.js';
import { listComponentsText } from './tools/list-components.js';
import { listNetsText, traceNetText } from './tools/nets.js';
import { getComponentText } from './tools/component.js';
import { getBomText } from './tools/bom.js';
import { docKind, collectionCounts, approxBytes } from './model/document.js';
import type { StdDocument } from './model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeScript = resolve(here, '../../probe/std-bridge.js');

const bridge = new Bridge(bridgeScript);
await bridge.start();

const server = new McpServer({ name: 'easyeda-std-mcp', version: '0.1.0' });

/** Shared guard: every document-reading tool needs the same three checks. */
async function withDocument<T>(fn: (doc: StdDocument) => T | Promise<T>): Promise<string> {
  if (bridge.listenError) {
    return `Bridge server is not listening: ${bridge.listenError}\nRun easyeda_doctor for details.`;
  }
  if (bridge.state !== 'connected') {
    return (
      'No EasyEDA editor is attached.\n\n' +
      'In EasyEDA (Standard): Advanced -> Extensions -> Run Script... ->\n' +
      '"Load from js file..." -> probe/std-bridge.js -> Run\n\n' +
      'Run easyeda_doctor for a full diagnosis.'
    );
  }
  let doc: StdDocument | null;
  try {
    doc = (await bridge.getSource()) as StdDocument | null;
  } catch (e) {
    return `Failed to read the document from the editor: ${String(e)}\nRun easyeda_doctor.`;
  }
  if (!doc) {
    return 'The editor is attached but no document is open. Open a schematic or PCB and try again.';
  }
  const out = await fn(doc);
  return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
}

server.registerTool(
  'easyeda_doctor',
  {
    title: 'Diagnose the EasyEDA bridge',
    description:
      'Check the EasyEDA Std bridge end to end: is the server listening, is the editor ' +
      'attached, is a document open. Run this first in any session, and whenever another ' +
      'EasyEDA tool reports a problem.',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: await doctor(bridge) }] }),
);

server.registerTool(
  'easyeda_get_context',
  {
    title: 'Summarise the open document',
    description:
      'Cheap orientation call: document type, approximate size, and the top-level ' +
      'collections with object counts. Use before heavier tools to see what is open.',
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: await withDocument((doc) => {
          const bytes = approxBytes(doc);
          const counts = collectionCounts(doc).filter((c) => c.count > 0);
          const lines = [
            `Document type: ${docKind(doc)}`,
            `Approximate size: ${(bytes / 1024).toFixed(0)} KB`,
            '',
            'Collections:',
            ...counts.map((c) => `  ${c.name.padEnd(16)} ${c.count}`),
          ];
          return lines.join('\n');
        }),
      },
    ],
  }),
);

server.registerTool(
  'easyeda_list_components',
  {
    title: 'List schematic components',
    description:
      'List components in the open schematic: designator, name, footprint, LCSC part ' +
      'number and pin count. Supports a substring filter across all those fields.',
    inputSchema: {
      filter: z
        .string()
        .optional()
        .describe('Case-insensitive substring matched against designator, name, footprint, manufacturer and part numbers'),
      limit: z.number().int().positive().optional().describe('Maximum rows to return (default 200)'),
    },
  },
  async ({ filter, limit }) => ({
    content: [
      { type: 'text', text: await withDocument((doc) => listComponentsText(doc, { filter, limit })) },
    ],
  }),
);

server.registerTool(
  'easyeda_list_nets',
  {
    title: 'List nets',
    description:
      'List nets in the open schematic with their connection counts. Nets are derived from ' +
      'schematic geometry (EasyEDA Std stores no explicit netlist), so unnamed local nets ' +
      'appear alongside named ones.',
    inputSchema: {
      filter: z.string().optional().describe('Case-insensitive substring matched against the net name'),
      namedOnly: z.boolean().optional().describe('Show only nets that carry a net label (e.g. GND, VDD)'),
      includeUnconnected: z
        .boolean()
        .optional()
        .describe('Include single-pin groups, i.e. pins connected to nothing (hidden by default)'),
      limit: z.number().int().positive().optional().describe('Maximum rows (default 100)'),
    },
  },
  async ({ filter, namedOnly, limit, includeUnconnected }) => ({
    content: [
      { type: 'text', text: await withDocument((doc) => listNetsText(doc, { filter, namedOnly, limit, includeUnconnected })) },
    ],
  }),
);

server.registerTool(
  'easyeda_trace_net',
  {
    title: 'Trace a net',
    description:
      'Given a net name (e.g. "GND") or a synthesised id for an unnamed net (e.g. "N$7"), ' +
      'list every pin on that net with its owning component.',
    inputSchema: {
      net: z.string().describe('Net name or synthesised id'),
    },
  },
  async ({ net }) => ({
    content: [{ type: 'text', text: await withDocument((doc) => traceNetText(doc, net)) }],
  }),
);

server.registerTool(
  'easyeda_get_component',
  {
    title: 'Get component detail',
    description:
      'Full detail for one component by designator: part identity, supplier part numbers, ' +
      'and every pin with the net it connects to.',
    inputSchema: {
      designator: z.string().describe('Component designator, e.g. "U1" or "R12"'),
    },
  },
  async ({ designator }) => ({
    content: [{ type: 'text', text: await withDocument((doc) => getComponentText(doc, designator)) }],
  }),
);

server.registerTool(
  'easyeda_get_bom',
  {
    title: 'Get grouped BOM',
    description:
      'Bill of materials for the open schematic, grouped by part identity and footprint, ' +
      'with quantities, designators and supplier part numbers. Components marked ' +
      'add_into_bom=no are excluded and reported.',
    inputSchema: {
      limit: z.number().int().positive().optional().describe('Maximum BOM lines (default 200)'),
    },
  },
  async ({ limit }) => ({
    content: [{ type: 'text', text: await withDocument((doc) => getBomText(doc, { limit })) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the MCP channel — diagnostics must go to stderr only.
process.stderr.write(
  bridge.listenError
    ? `[easyeda-std-mcp] WARNING: ${bridge.listenError}\n`
    : `[easyeda-std-mcp] bridge listening on 127.0.0.1:3579\n`,
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void bridge.stop().then(() => process.exit(0));
  });
}
