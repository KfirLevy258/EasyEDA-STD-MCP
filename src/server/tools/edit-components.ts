import type { Bridge } from '../bridge.js';
import type { BackupStore } from '../backup.js';
import { applyFieldEdits, checkIntegrity, type EditableField, type FieldChange } from '../model/edit.js';
import { listComponents } from '../model/components.js';
import { docKind, documentId } from '../model/document.js';
import { renderTable } from './list-components.js';
import type { StdDocument } from '../model/types.js';

export interface EditRequest {
  designators?: string[];
  filter?: string;
  field: EditableField;
  value: string;
  apply?: boolean;
}

/**
 * Edit component fields, with a preview-by-default workflow.
 *
 * The write path is: snapshot -> edit in memory -> integrity check -> write ->
 * read back -> verify -> roll back if anything moved. Because `applySource`
 * rewrites the whole live document and reports nothing useful on return, every
 * one of those steps is load-bearing.
 */
export async function editComponents(
  bridge: Bridge,
  backups: BackupStore,
  req: EditRequest,
): Promise<string> {
  const doc = (await bridge.getSource()) as StdDocument | null;
  if (!doc) return 'No document is open in the editor.';
  if (docKind(doc) === 'pcb') {
    return 'The active document is a PCB. Component editing is implemented for schematics only.';
  }

  // Resolve which components to touch.
  const all = listComponents(doc);
  let targets: string[];
  if (req.designators?.length) {
    targets = req.designators;
  } else if (req.filter) {
    const q = req.filter.toLowerCase();
    targets = all
      .filter(
        (c) =>
          c.designator.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          (c.footprint ?? '').toLowerCase().includes(q) ||
          (c.supplierPart ?? '').toLowerCase().includes(q),
      )
      .map((c) => c.designator);
  } else {
    return 'Specify either `designators` or `filter` — refusing to edit every component by default.';
  }

  if (targets.length === 0) {
    return `Nothing matched${req.filter ? ` "${req.filter}"` : ''}. No changes made.`;
  }

  const edits = targets.map((d) => ({ designator: d, field: req.field, value: req.value }));
  const { doc: edited, changes, errors } = applyFieldEdits(doc, edits);

  const lines: string[] = [];
  if (errors.length) {
    lines.push('Problems:');
    for (const e of errors) lines.push(`  - ${e}`);
    lines.push('');
  }

  if (changes.length === 0) {
    lines.push(
      targets.length > 0 && errors.length === 0
        ? `All ${targets.length} matched component(s) already have ${req.field} = "${req.value}". Nothing to do.`
        : 'No changes to apply.',
    );
    return lines.join('\n');
  }

  lines.push(renderChangeTable(changes));
  lines.push('');

  // Field edits must not alter topology. Check before writing, not after.
  const integrity = checkIntegrity(doc, edited);
  if (!integrity.ok) {
    lines.push('REFUSING TO WRITE — the edit changed the document structure:');
    for (const p of integrity.problems) lines.push(`  - ${p}`);
    lines.push('');
    lines.push('This is a bug in the edit logic, not something to force. Nothing was written.');
    return lines.join('\n');
  }

  if (!req.apply) {
    lines.push(`PREVIEW ONLY — ${changes.length} change(s) not yet written.`);
    lines.push('Re-run with apply: true to write them to the editor.');
    return lines.join('\n');
  }

  // --- writing from here ---
  const backupId = backups.save(doc, `before-${req.field}-${changes.length}`);
  lines.push(`Restore point saved: ${backupId}`);

  try {
    await bridge.applySource(edited);
  } catch (e) {
    lines.push(`WRITE FAILED: ${String(e)}`);
    lines.push(`The document was not modified. Restore point ${backupId} is available if needed.`);
    return lines.join('\n');
  }

  // applySource tells us nothing on return, so read back and check.
  const after = (await bridge.getSource()) as StdDocument | null;
  if (after && documentId(after) !== documentId(doc)) {
    lines.push('');
    lines.push('DOCUMENT CHANGED DURING THE WRITE — the editor switched to a different board');
    lines.push(`  expected ${documentId(doc)}, now showing ${documentId(after)}`);
    lines.push(`Do NOT restore blindly. Switch back to the original document, then use`);
    lines.push(`easyeda_restore_backup with the restore point above.`);
    return lines.join('\n');
  }
  if (!after) {
    lines.push('WARNING: could not read the document back after writing. Verify manually.');
    return lines.join('\n');
  }

  const verify = checkIntegrity(doc, after);
  const applied = countApplied(after, changes);

  if (!verify.ok) {
    lines.push('');
    lines.push('WRITE VERIFICATION FAILED — rolling back:');
    for (const p of verify.problems) lines.push(`  - ${p}`);
    try {
      await bridge.applySource(doc);
      lines.push(`Rolled back to the pre-write state (restore point ${backupId}).`);
    } catch (e) {
      lines.push(`ROLLBACK ALSO FAILED: ${String(e)}`);
      lines.push(`Restore manually with easyeda_restore_backup and id ${backupId}.`);
    }
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Applied ${applied} of ${changes.length} change(s). Structure verified unchanged:`);
  lines.push(
    `  components ${verify.after.components}, wires ${verify.after.wires}, ` +
      `nets ${verify.after.nets}, orphan pins ${verify.after.orphanPins}`,
  );
  if (applied !== changes.length) {
    lines.push('');
    lines.push('WARNING: not every change is present in the read-back. The editor may have');
    lines.push('normalised or rejected some values. Inspect before relying on this.');
  }
  return lines.join('\n');
}

function countApplied(after: StdDocument, changes: FieldChange[]): number {
  const comps = new Map(listComponents(after).map((c) => [c.designator, c]));
  let n = 0;
  for (const ch of changes) {
    // A designator edit moves the component's own key, so look it up by its new name.
    const key = ch.field === 'designator' ? ch.to : ch.designator;
    const c = comps.get(key);
    if (!c) continue;
    const actual: Record<FieldChange['field'], string | undefined> = {
      value: c.name,
      designator: c.designator,
      footprint: c.footprint,
      lcsc: c.supplierPart,
      manufacturer: c.manufacturer,
      manufacturerPart: c.manufacturerPart,
    };
    if ((actual[ch.field] ?? '') === ch.to) n++;
  }
  return n;
}

function renderChangeTable(changes: FieldChange[]): string {
  const shown = changes.slice(0, 100);
  const rows = shown.map((c) => [c.designator, c.field, c.from || '(empty)', c.to || '(empty)']);
  const table = renderTable(['Designator', 'Field', 'From', 'To'], rows);
  return changes.length > shown.length
    ? `${table}\n… and ${changes.length - shown.length} more`
    : table;
}

export async function restoreBackup(
  bridge: Bridge,
  backups: BackupStore,
  id: string,
): Promise<string> {
  let doc: StdDocument;
  try {
    doc = backups.load(id);
  } catch (e) {
    const available = backups.list().slice(0, 10).map((b) => `  ${b.id}  (${(b.bytes / 1024).toFixed(0)} KB)`);
    return `Could not load restore point "${id}": ${String(e)}\n\nAvailable:\n${available.join('\n') || '  (none)'}`;
  }

  const current = (await bridge.getSource()) as StdDocument | null;

  // A restore writes a whole document. If the editor is showing a DIFFERENT board than
  // the snapshot came from, this would overwrite that board wholesale — so refuse.
  const snapId = documentId(doc);
  const liveId = documentId(current);
  if (snapId && liveId && snapId !== liveId) {
    return (
      `REFUSING TO RESTORE — wrong document is open.\n\n` +
      `  snapshot is of document ${snapId}\n` +
      `  editor currently shows  ${liveId}\n\n` +
      'Restoring would overwrite the open board with a different one. Switch EasyEDA back ' +
      'to the document this snapshot came from, then run this again.'
    );
  }

  if (current) backups.save(current, 'before-restore');

  await bridge.applySource(doc);

  const after = (await bridge.getSource()) as StdDocument | null;
  if (!after) return `Restored ${id}, but could not read the document back to verify.`;

  const verify = checkIntegrity(doc, after);
  return verify.ok
    ? `Restored ${id}. Verified: ${verify.after.components} components, ${verify.after.wires} wires, ${verify.after.nets} nets.`
    : `Restored ${id}, but verification found differences:\n  ${verify.problems.join('\n  ')}`;
}

export function listBackupsText(backups: BackupStore): string {
  const list = backups.list();
  if (list.length === 0) return `No restore points yet. They are written to ${backups.directory}.`;
  const rows = list.slice(0, 40).map((b) => [b.id, `${(b.bytes / 1024).toFixed(0)} KB`, b.mtime.toISOString()]);
  return [
    `${list.length} restore point(s) in ${backups.directory}:`,
    '',
    renderTable(['Id', 'Size', 'Taken'], rows),
  ].join('\n');
}
