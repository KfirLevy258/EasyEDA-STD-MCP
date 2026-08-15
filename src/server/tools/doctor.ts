import type { Bridge } from '../bridge.js';
import { BRIDGE_PORT, PROTOCOL } from '../bridge.js';
import { docKind, collectionCounts, approxBytes } from '../model/document.js';
import type { StdDocument } from '../model/types.js';

/**
 * Diagnose the whole chain, and say which link is broken in words the user can act on.
 *
 * The three states the handoff calls for are genuinely distinguished, because they
 * have completely different fixes:
 *   - no editor attached      -> run the bridge script in EasyEDA
 *   - attached, no document   -> open a board
 *   - attached, document open -> working
 * Most support friction lands here, so each state names its own next action.
 */
export async function doctor(bridge: Bridge): Promise<string> {
  const lines: string[] = [];
  const ok = (s: string) => lines.push(`  [ok]   ${s}`);
  const bad = (s: string) => lines.push(`  [FAIL] ${s}`);
  const warn = (s: string) => lines.push(`  [warn] ${s}`);

  lines.push('EasyEDA Std bridge — diagnostics');
  lines.push('');

  // Link 1: is our listener up?
  if (bridge.listenError) {
    bad(`bridge server NOT listening on 127.0.0.1:${BRIDGE_PORT}`);
    lines.push(`         ${bridge.listenError}`);
    lines.push('');
    lines.push('STATE: bridge server could not start.');
    lines.push('');
    lines.push('The port is not negotiable: the EasyEDA desktop client only permits');
    lines.push(`ws://127.0.0.1:${BRIDGE_PORT} via its Content-Security-Policy. Free that port`);
    lines.push('(check for another copy of this MCP server) and restart.');
    return lines.join('\n');
  }
  ok(`bridge server listening on 127.0.0.1:${BRIDGE_PORT}`);

  // Link 2: is the editor attached?
  if (bridge.state !== 'connected') {
    bad('no EasyEDA editor attached');
    lines.push('');
    lines.push('STATE: waiting for the editor to connect.');
    lines.push('');
    lines.push('In EasyEDA (Standard), with a board open:');
    lines.push('  Advanced -> Extensions -> Run Script...');
    lines.push('  -> "Load from js file..." -> select probe/std-bridge.js -> Run');
    lines.push('');
    lines.push('The script must be LOADED FROM FILE (or pasted whole). Bootstrapping it');
    lines.push('with fetch().then(eval) fails: that evaluates in global scope, where the');
    lines.push('editor\'s injected api() is not visible.');
    return lines.join('\n');
  }
  ok(`editor attached (protocol ${bridge.editorHello ?? 'unknown'})`);
  if (bridge.editorHello && bridge.editorHello !== PROTOCOL) {
    warn(`editor speaks ${bridge.editorHello}, server expects ${PROTOCOL} — version mismatch`);
  }

  // Link 3: does api() answer?
  let ping;
  try {
    ping = await bridge.call('__ping', {}, 5000);
  } catch (e) {
    bad(`RPC failed: ${String(e)}`);
    return lines.join('\n');
  }
  if (!ping.ok) {
    bad(`RPC round-trip failed: ${ping.error}`);
    return lines.join('\n');
  }
  ok('RPC round-trip works');

  // Link 4: is a document open?
  let doc: StdDocument | null = null;
  try {
    doc = (await bridge.getSource()) as StdDocument | null;
  } catch (e) {
    bad(`getSource() failed: ${String(e)}`);
    return lines.join('\n');
  }

  if (!doc) {
    warn('no document open (getSource returned nothing)');
    lines.push('');
    lines.push('STATE: connected, but no document is open.');
    lines.push('');
    lines.push('Open a schematic or PCB in EasyEDA, then run this again. Note the editor');
    lines.push('must have an ACTIVE document tab — the Start page does not count.');
    return lines.join('\n');
  }

  const kind = docKind(doc);
  const bytes = approxBytes(doc);
  ok(`document open: ${kind}, ~${(bytes / 1024).toFixed(0)} KB`);
  if (kind === 'unknown') {
    warn('document type not recognised — tools may not understand this document');
  }

  lines.push('');
  lines.push('STATE: connected, document open. Ready.');
  lines.push('');
  const counts = collectionCounts(doc).filter((c) => c.count > 0).slice(0, 8);
  lines.push(`Top collections: ${counts.map((c) => `${c.name}=${c.count}`).join(', ')}`);
  return lines.join('\n');
}
