/* EasyEDA Std bridge diagnostic — reports via alert(), so it works even when the
 * network path is dead. Run via: Advanced -> Extensions -> Run Script... ->
 * "Load from js file..." -> pick this file -> Run.
 * Read-only: touches no document data beyond asking whether one is open.
 */
(function () {
  var PORT = 3579;   // hardcoded in the desktop client's CSP connect-src allowlist
  var lines = [];
  function add(k, v) { lines.push(k + ': ' + v); }

  // 1. Is api() in scope here at all?
  var api;
  try { api = eval('api'); } catch (e) { /* not in scope */ }
  add('typeof api', typeof api);

  // 2. Basic web platform bits
  add('typeof fetch', typeof fetch);
  add('typeof WebSocket', typeof WebSocket);
  add('typeof XMLHttpRequest', typeof XMLHttpRequest);
  try { add('origin', location.origin); } catch (e) { add('origin', 'ERR ' + e.message); }
  try { add('electron', /Electron/i.test(navigator.userAgent) ? 'yes' : 'no'); } catch (e) {}

  // 3. Is a document open?
  if (typeof api === 'function') {
    try {
      var src = api('getSource', { type: 'json' });
      add('getSource', src === undefined ? 'undefined (no doc open?)'
        : (typeof src === 'object' ? 'OBJECT with ' + Object.keys(src).length + ' top-level keys' : typeof src));
    } catch (e) { add('getSource', 'THREW ' + e.message); }
  }

  // 4. Network probes — run both, report whichever finishes.
  var net = { http: 'pending', ws: 'pending' };
  var reported = false;

  function report(why) {
    if (reported) return;
    reported = true;
    add('http->127.0.0.1:' + PORT, net.http);
    add('ws->127.0.0.1:' + PORT, net.ws);
    var msg = 'EasyEDA bridge diagnostic (' + why + ')\n\n' + lines.join('\n');
    try { console.log(msg); } catch (e) {}
    try { alert(msg); } catch (e) {}
  }

  // HTTP probe
  try {
    if (typeof fetch === 'function') {
      fetch('http://127.0.0.1:' + PORT + '/status')
        .then(function (r) { return r.text(); })
        .then(function (t) { net.http = 'OK ' + String(t).slice(0, 60); })
        .catch(function (e) { net.http = 'FAIL ' + (e && e.message ? e.message : e); });
    } else net.http = 'no fetch';
  } catch (e) { net.http = 'THREW ' + e.message; }

  // WebSocket probe
  try {
    var ws = new WebSocket('ws://127.0.0.1:' + PORT);
    ws.onopen = function () { net.ws = 'OPEN'; ws.send('diagnostic-hello'); };
    ws.onmessage = function (m) { net.ws = 'OPEN + echo: ' + String(m.data).slice(0, 40); };
    ws.onerror = function () { if (net.ws === 'pending') net.ws = 'ERROR (blocked or refused)'; };
    ws.onclose = function (e) { if (net.ws === 'pending') net.ws = 'CLOSED code=' + e.code; };
  } catch (e) { net.ws = 'THREW ' + e.message; }

  setTimeout(function () { report('after 4s'); }, 4000);
})();
