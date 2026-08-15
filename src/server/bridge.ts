import { createServer, type Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * The MCP server owns the WebSocket *server*; the editor-side script is the
 * *client* and reconnects on drop (the editor is the flaky end of the link).
 *
 * The port is NOT configurable in practice. The EasyEDA desktop client injects a
 * CSP whose connect-src allows exactly `http://127.0.0.1:3579` and
 * `ws://127.0.0.1:3579` and nothing else insecure. Any other port is blocked by
 * Chromium before a packet is emitted — no error, no traffic, total silence.
 * See FINDINGS.md §6.
 */
export const BRIDGE_PORT = 3579;
export const PROTOCOL = 'easyeda-std-bridge/0.1';

export type BridgeState = 'no-server' | 'awaiting-editor' | 'connected';

interface Pending {
  resolve: (value: RpcReply) => void;
  timer: NodeJS.Timeout;
}

export interface RpcReply {
  id: number;
  ok: boolean;
  result?: unknown;
  resultType?: string;
  error?: string;
  stack?: string;
}

export class Bridge {
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private editor: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  /** Set when the port is held by something else — surfaced by the doctor tool. */
  public listenError: string | null = null;
  public editorHello: string | null = null;
  public connectedAt: number | null = null;
  /** Path to the editor-side script, served over HTTP for convenience. */
  constructor(private bridgeScriptPath?: string) {}

  get state(): BridgeState {
    if (!this.wss) return 'no-server';
    return this.editor && this.editor.readyState === 1 ? 'connected' : 'awaiting-editor';
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      const http = createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
        if (req.url?.startsWith('/bridge.js') && this.bridgeScriptPath) {
          try {
            const js = readFileSync(this.bridgeScriptPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            return res.end(js);
          } catch (e) {
            res.writeHead(500);
            return res.end(String(e));
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ protocol: PROTOCOL, state: this.state }));
      });

      http.on('error', (err: NodeJS.ErrnoException) => {
        this.listenError =
          err.code === 'EADDRINUSE'
            ? `port ${BRIDGE_PORT} is already in use — another MCP server instance, or EasyEDA's own local helper, is holding it`
            : String(err.message ?? err);
        resolve();
      });

      const wss = new WebSocketServer({ server: http });
      wss.on('connection', (ws) => this.onConnection(ws));
      // The WebSocketServer re-emits the HTTP server's listen errors. Without a
      // handler here an EADDRINUSE becomes an unhandled 'error' event and kills the
      // process — instead of the doctor reporting a busy port, which is the whole
      // point of tracking listenError.
      wss.on('error', () => void 0);

      http.listen(BRIDGE_PORT, '127.0.0.1', () => {
        this.http = http;
        this.wss = wss;
        this.listenError = null;
        resolve();
      });
    });
  }

  private onConnection(ws: WebSocket): void {
    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore non-JSON chatter
      }

      // Handshake: confirm we are talking to our own bridge, not whatever else
      // may legitimately want port 3579.
      if (typeof msg.hello === 'string') {
        this.editor = ws;
        this.editorHello = msg.hello;
        this.connectedAt = Date.now();
        return;
      }

      const id = msg.id;
      if (typeof id === 'number') {
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.resolve(msg as unknown as RpcReply);
        }
      }
    });

    ws.on('close', () => {
      if (this.editor === ws) {
        this.editor = null;
        this.editorHello = null;
        this.connectedAt = null;
      }
    });
    ws.on('error', () => void 0);
  }

  /** Call an api() method inside the editor. Rejects if no editor is attached. */
  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<RpcReply> {
    if (!this.editor || this.editor.readyState !== 1) {
      throw new Error('no editor connected');
    }
    const id = this.nextId++;
    return new Promise<RpcReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: `timed out after ${timeoutMs}ms waiting for the editor` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.editor!.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Fetch the active document.
   *
   * Returns null when no document is open. Note that api() returns undefined both
   * for "no document" and for an unknown method name — the dispatcher swallows
   * unknown methods silently (FINDINGS.md §3) — so callers must not read a null
   * here as proof that nothing is open.
   */
  async getSource(): Promise<unknown | null> {
    const reply = await this.call('getSource', { type: 'json' });
    if (!reply.ok) throw new Error(reply.error ?? 'getSource failed');
    return reply.result ?? null;
  }

  /**
   * Write a document back to the LIVE editor.
   *
   * There is no safe mode. `createNew: true` is documented as opening the result in
   * a new tab; against the real editor it does not — it overwrites the open document
   * (FINDINGS.md §11). So this always passes `createNew: false` and states plainly
   * what it is doing, rather than implying a sandbox that does not exist.
   *
   * Callers must snapshot first and verify afterwards. See writeVerified().
   */
  async applySource(doc: unknown): Promise<void> {
    const reply = await this.call('applySource', { source: doc as Record<string, unknown>, createNew: false }, 60_000);
    // applySource returns undefined on success AND for an unknown method name, so
    // its return value proves nothing. Verification is the caller's job.
    if (!reply.ok) throw new Error(reply.error ?? 'applySource failed');
  }

  async stop(): Promise<void> {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.wss?.close();
    this.http?.close();
    this.wss = null;
    this.http = null;
  }
}
