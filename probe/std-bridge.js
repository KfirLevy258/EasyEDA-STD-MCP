/* EasyEDA Std bridge — thin RPC dispatcher (probe/exploration build).
 * Run via: Advanced -> Extensions -> Run Script...
 *
 * Protocol: server sends {id, method, params}; we reply {id, ok, result|error}.
 * The extension stays dumb: it calls api(method, params) and reports what happened.
 *
 * NOTE: this build includes a __eval escape hatch for API-surface exploration.
 * It must NOT ship in the Phase 1 extension.
 */
(function () {
  var PORT = 3579;   // hardcoded in the desktop client's CSP connect-src allowlist
  var HELLO = 'easyeda-std-bridge/0.1';

  // `api` is injected into user-script scope, not onto window.
  var api;
  try { api = eval('api'); } catch (e) {}
  if (typeof api !== 'function' && typeof window !== 'undefined' && window.__eda_api) {
    api = window.__eda_api;
  }
  if (typeof api !== 'function') {
    console.log('[bridge] FATAL: api() not in scope — run this from Advanced > Extensions > Run Script');
    return;
  }
  window.__eda_api = api;

  // Tear down a previous instance so re-running the script is safe.
  if (window.__edaBridge && window.__edaBridge.stop) {
    try { window.__edaBridge.stop(); } catch (e) {}
  }

  var state = { ws: null, stopped: false, reconnects: 0 };
  window.__edaBridge = state;
  state.stop = function () {
    state.stopped = true;
    if (state.ws) { try { state.ws.close(); } catch (e) {} }
    console.log('[bridge] stopped');
  };

  function safeStringify(v) {
    var seen = [];
    return JSON.stringify(v, function (k, val) {
      if (typeof val === 'function') return '[Function]';
      if (val && typeof val === 'object') {
        if (seen.indexOf(val) >= 0) return '[Circular]';
        seen.push(val);
      }
      return val;
    });
  }

  function handle(msg) {
    var reply = { id: msg.id, ok: false };
    try {
      var result;
      if (msg.method === '__ping') {
        result = { hello: HELLO, ts: Date.now() };
      } else if (msg.method === '__eval') {
        // exploration only
        result = eval(msg.params && msg.params.expr);
      } else {
        result = api(msg.method, msg.params || {});
      }
      reply.ok = true;
      reply.resultType = Object.prototype.toString.call(result);
      reply.result = result;
    } catch (e) {
      reply.error = String(e && e.message ? e.message : e);
      reply.stack = String(e && e.stack || '').split('\n').slice(0, 4).join(' | ');
    }
    var payload;
    try { payload = safeStringify(reply); }
    catch (e) { payload = JSON.stringify({ id: msg.id, ok: false, error: 'unserialisable result: ' + e.message }); }
    try { state.ws.send(payload); } catch (e) { console.log('[bridge] send failed', e); }
  }

  function connect() {
    if (state.stopped) return;
    var ws;
    try { ws = new WebSocket('ws://127.0.0.1:' + PORT); }
    catch (e) { console.log('[bridge] construct failed', e); return schedule(); }
    state.ws = ws;

    ws.onopen = function () {
      state.reconnects = 0;
      if (state.markConnected) state.markConnected();
      console.log('[bridge] connected to 127.0.0.1:' + PORT);
      ws.send(JSON.stringify({ hello: HELLO, role: 'editor' }));
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); }
      catch (e) { return; } // ignore non-JSON (e.g. server chatter)
      if (msg && msg.id !== undefined && msg.method) handle(msg);
    };
    ws.onerror = function () { console.log('[bridge] socket error'); };
    ws.onclose = function (e) {
      console.log('[bridge] closed code=' + e.code + ' — reconnecting');
      schedule();
    };
  }

  function schedule() {
    if (state.stopped) return;
    state.reconnects++;
    var delay = Math.min(1000 * state.reconnects, 5000);
    setTimeout(connect, delay);
  }

  connect();
  console.log('[bridge] ' + HELLO + ' installed. Stop with window.__edaBridge.stop()');

  // Fail loudly: a silent no-op is the worst outcome when running from a dialog
  // with no visible console.
  var everConnected = false;
  state.markConnected = function () { everConnected = true; };
  setTimeout(function () {
    if (!everConnected && !state.stopped) {
      try {
        alert('EasyEDA bridge could not reach 127.0.0.1:' + PORT + ' after 6s.\n\n' +
              'The bridge script DID run (api was in scope), so the problem is the ' +
              'network path, not the script. Run probe/std-diagnose.js for detail.');
      } catch (e) {}
    }
  }, 6000);
})();
