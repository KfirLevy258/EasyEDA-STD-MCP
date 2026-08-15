import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { StdDocument } from './model/types.js';

/**
 * Snapshots taken immediately before every write.
 *
 * This is not a nicety. `applySource` writes the whole document to the LIVE editor —
 * there is no dry-run and no sandbox. `createNew: true` is documented as opening the
 * result in a new tab; it does not (verified against the real editor, see FINDINGS
 * §11), it overwrites the open document. So the only safety net is our own.
 */
export class BackupStore {
  private dir: string;

  constructor(root: string) {
    this.dir = resolve(root, 'backups');
    mkdirSync(this.dir, { recursive: true });
  }

  /** Write a restore point. Returns its id. */
  save(doc: StdDocument, label: string): string {
    // Date.now is fine here: this runs in the MCP server, not a workflow script.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = label.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
    const id = `${stamp}__${safe}`;
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(doc));
    return id;
  }

  list(): Array<{ id: string; bytes: number; mtime: Date }> {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const st = statSync(join(this.dir, f));
        return { id: f.replace(/\.json$/, ''), bytes: st.size, mtime: st.mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  load(id: string): StdDocument {
    const clean = id.replace(/\.json$/, '');
    // Never let a caller escape the backup directory.
    if (clean.includes('/') || clean.includes('..')) throw new Error(`invalid backup id: ${id}`);
    return JSON.parse(readFileSync(join(this.dir, `${clean}.json`), 'utf8')) as StdDocument;
  }

  get directory(): string {
    return this.dir;
  }
}
