/* EasyEDA Std bridge probe — read-only, no mutations.
 * Run via: Advanced -> Extensions -> Run Script...  (or "Load from js file...")
 * Connects to the local probe server and reports environment + document structure.
 * Sends only STRUCTURE (key names, counts, small samples) — never the whole document.
 */
(function () {
  var PORT = 3579;
  var out = { stage: 'init' };

  // `api` is injected into user-script scope, NOT onto window. When this file is
  // pasted directly into the Run Script box, the bare identifier resolves via the
  // scope chain. When it is fetched+eval'd, the loader stashes it as window.__eda_api.
  var api;
  try { api = eval('api'); } catch (e) { /* not in this scope */ }
  if (typeof api !== 'function' && typeof window !== 'undefined') {
    api = window.__eda_api;
  }

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return (fallback === undefined ? ('ERR: ' + e.message) : fallback); }
  }

  // ---- environment ----
  out.env = {
    typeof_api: typeof api,
    origin: safe(function () { return location.origin; }),
    href: safe(function () { return location.href.slice(0, 120); }),
    ua: safe(function () { return navigator.userAgent; }),
    isElectron: safe(function () {
      return /Electron/i.test(navigator.userAgent) ||
             (typeof process !== 'undefined' && !!(process.versions && process.versions.electron));
    }),
    electronVersion: safe(function () {
      return (typeof process !== 'undefined' && process.versions) ? process.versions.electron : null;
    }, null),
    nodeIntegration: safe(function () { return typeof require === 'function'; }, false),
    isSecureContext: safe(function () { return window.isSecureContext; })
  };

  // ---- document structure (read-only) ----
  function describe(src) {
    if (src === undefined || src === null) return { present: false, raw: String(src) };
    if (typeof src === 'string') return { present: true, type: 'string', length: src.length, head: src.slice(0, 120) };
    var d = { present: true, type: 'object', topLevelKeys: [], collections: {}, scalars: {} };
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      d.topLevelKeys.push(k);
      var v = src[k];
      if (v && typeof v === 'object') {
        var keys = Object.keys(v);
        d.collections[k] = { count: keys.length, sampleKeys: keys.slice(0, 3) };
        // one small structural sample: field names only, plus tiny values
        if (keys.length) {
          var sample = v[keys[0]];
          if (sample && typeof sample === 'object') {
            var fields = {};
            Object.keys(sample).slice(0, 40).forEach(function (f) {
              var sv = sample[f];
              var t = Object.prototype.toString.call(sv);
              if (sv === null || ['string', 'number', 'boolean'].indexOf(typeof sv) >= 0) {
                fields[f] = String(sv).slice(0, 60);
              } else if (Array.isArray(sv)) {
                fields[f] = '[Array len=' + sv.length + ']';
              } else {
                fields[f] = t;
              }
            });
            d.collections[k].sampleFields = fields;
          } else {
            d.collections[k].sampleValue = String(sample).slice(0, 60);
          }
        }
      } else {
        d.scalars[k] = String(v).slice(0, 80);
      }
    }
    return d;
  }

  if (typeof api === 'function') {
    out.getSource = safe(function () { return describe(api('getSource', { type: 'json' })); });
    out.unitConvert_mil2pixel_10 = safe(function () {
      return api('edit.unitConvert', { type: 'mil2pixel', value: 10 });
    });
    // Which doc is active / what does the editor think is open?
    out.docInfo = safe(function () {
      var s = api('getSource', { type: 'json' });
      if (!s) return 'no document';
      return {
        docType: s.docType !== undefined ? s.docType : (s.head && s.head.docType),
        headKeys: s.head ? Object.keys(s.head).slice(0, 20) : null,
        editorVersion: s.editorVersion || (s.head && s.head.editorVersion)
      };
    });
  } else {
    out.getSource = 'api not available';
  }

  out.stage = 'collected';

  // ---- report back ----
  var payload = JSON.stringify(out);
  console.log('PROBE payload bytes =', payload.length);
  console.log('PROBE env =', JSON.stringify(out.env));

  try {
    var ws = new WebSocket('ws://127.0.0.1:' + PORT);
    ws.onopen = function () {
      console.log('PROBE BRIDGE OK — connected to 127.0.0.1:' + PORT);
      ws.send('PROBE_REPORT ' + payload);
    };
    ws.onmessage = function (m) { console.log('PROBE RECV', String(m.data).slice(0, 200)); };
    ws.onerror = function (e) { console.log('PROBE BLOCKED — WebSocket error', e); };
    ws.onclose = function (e) { console.log('PROBE CLOSE code=' + e.code); };
  } catch (e) {
    console.log('PROBE THREW on WebSocket construct:', e.message);
  }
})();
