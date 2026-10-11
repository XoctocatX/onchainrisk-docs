/**
 * Safe structural diff — answers "what would change if we publish?" without printing a value.
 *
 * Diagnostic only: it reads the two already-normalized collections, so it sees exactly what the
 * NOOP/UPDATE decision sees and influences nothing about binding, normalization, identity, the
 * payload or verification.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeDiff, formatSafeDiff, safeLabel, safeComponent, safeKey, safePath, safeMethod,
  contentHash, readLocal, COLLECTIONS,
} from '../postman-sync.mjs';

const base = () => ({
  info: { name: 'C', description: 'prose', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    {
      name: 'Analysis',
      item: [
        {
          name: 'POST check',
          request: {
            method: 'POST',
            url: { raw: '{{base_url}}/api/v1/check' },
            header: [{ key: 'Authorization', value: 'Bearer {{paid_api_key}}' }],
            body: { mode: 'raw', raw: '{"address":"0xabc"}' },
          },
          event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("ok", () => {})'] } }],
          response: [{ name: '200 ok', code: 200, body: '{"riskScore":42}' }],
        },
      ],
    },
  ],
  variable: [{ key: 'base_url', value: 'https://api.example.test' }],
});

/** Collect formatted output without touching the console. */
const render = (diff, opts = {}) => {
  const lines = [];
  formatSafeDiff(diff, { ...opts, log: (l) => lines.push(String(l)) });
  return lines.join('\n');
};

describe('SAFE_DIFF_CLASSIFICATION', () => {
  test('identical inputs produce nothing', () => {
    assert.deepEqual(safeDiff(base(), base()), { added: [], removed: [], changed: [] });
  });

  test('present locally and absent remotely is ADDED', () => {
    const remote = base();
    delete remote.item[0].item[0].response;
    const d = safeDiff(base(), remote);
    assert.deepEqual(d.added, ['item[Analysis].item[POST /api/v1/check].response']);
    assert.deepEqual(d.removed, []);
  });

  test('present remotely and absent locally is REMOVED', () => {
    const local = base();
    delete local.item[0].item[0].response;
    const d = safeDiff(local, base());
    assert.deepEqual(d.removed, ['item[Analysis].item[POST /api/v1/check].response']);
    assert.deepEqual(d.added, []);
  });

  test('a differing scalar is CHANGED', () => {
    const remote = base();
    remote.info.description = 'edited in the UI';
    assert.deepEqual(safeDiff(base(), remote).changed, ['info.description']);
  });

  test('a whole new request is one ADDED path, not a tree of them', () => {
    const remote = base();
    remote.item[0].item.push({ name: 'GET rogue', request: { method: 'GET', url: { raw: '{{base_url}}/api/v1/rogue' } } });
    const d = safeDiff(base(), remote);
    assert.deepEqual(d.removed, ['item[Analysis].item[GET /api/v1/rogue]']);
    assert.deepEqual(d.added, []);
  });

  test('a shape change (object vs scalar) is CHANGED', () => {
    const remote = base();
    remote.item[0].item[0].request.body = 'a string now';
    assert.equal(safeDiff(base(), remote).changed.includes('item[Analysis].item[POST /api/v1/check].request.body'), true);
  });

  test('an array of scalars reports the array path once', () => {
    const remote = base();
    remote.item[0].item[0].event[0].script.exec = ['pm.test("edited", () => {})', 'extra()'];
    const d = safeDiff(base(), remote);
    assert.deepEqual(d.changed, ['item[Analysis].item[POST /api/v1/check].event[test].script.exec']);
  });

  test('the direction is local-as-target', () => {
    // ADDED means publishing would create it. An empty remote array is still keyable, so the
    // selector stays semantic rather than degrading to an index.
    const remote = base();
    remote.variable = [];
    assert.deepEqual(safeDiff(base(), remote).added, ['variable[base_url]']);
  });
});

describe('SAFE_DIFF_SEMANTIC_PATHS', () => {
  test('folders, requests, examples, events, headers and variables use stable selectors', () => {
    const remote = base();
    remote.item[0].item[0].request.header[0].value = 'Bearer different';
    remote.item[0].item[0].response[0].code = 418;
    remote.item[0].item[0].event[0].script.type = 'text/plain';
    remote.variable[0].value = 'https://elsewhere.test';
    const d = safeDiff(base(), remote);
    assert.deepEqual(d.changed, [
      'item[Analysis].item[POST /api/v1/check].event[test].script.type',
      'item[Analysis].item[POST /api/v1/check].request.header[Authorization].value',
      'item[Analysis].item[POST /api/v1/check].response[200 ok].code',
      'variable[base_url].value',
    ]);
  });

  test('a request is selected by method and normalized path, not by name', () => {
    const local = base();
    local.item[0].item[0].request.description = 'local prose';
    const remote = base();
    remote.item[0].item[0].request.description = 'remote prose';
    const [p] = safeDiff(local, remote).changed;
    assert.match(p, /item\[POST \/api\/v1\/check\]/);
    assert.equal(p.includes('POST check'), false, 'the request name is not the selector');
  });

  test('positional indexes are used only where no stable identity exists on BOTH sides', () => {
    // the real paid collection has two events with listen "test" on one request, so that array
    // is not keyable; a remote with one such event must not produce add/remove churn
    const local = readLocal('paid-collection.json');
    const remote = JSON.parse(JSON.stringify(local));
    const req = remote.item.find((x) => x.name === 'Analysis').item[0];
    assert.equal(req.event.filter((e) => e.listen === 'test').length > 1, true, 'fixture premise');
    req.event = [{ listen: 'test', script: { type: 'text/javascript', exec: ['edited()'] } }];
    const d = safeDiff(local, remote);
    const eventPaths = [...d.added, ...d.removed, ...d.changed].filter((p) => p.includes('.event'));
    // exactly one added index (the second local event) and one changed script, no name/index mix
    assert.equal(eventPaths.some((p) => p.includes('event[test]')), false, 'must not mix keyed and indexed');
    assert.equal(eventPaths.every((p) => /event\[\d+\]/.test(p)), true, `got ${eventPaths.join(', ')}`);
  });

  test('a duplicated example name falls back to indexes on both sides', () => {
    const local = base();
    local.item[0].item[0].response.push({ name: '200 ok', code: 201, body: '{}' });
    const remote = JSON.parse(JSON.stringify(local));
    remote.item[0].item[0].response[1].code = 202;
    const d = safeDiff(local, remote);
    assert.deepEqual(d.changed, ['item[Analysis].item[POST /api/v1/check].response[1].code']);
  });
});

describe('SAFE_DIFF_NO_VALUES', () => {
  test('no old or new content value appears anywhere in the output', () => {
    const local = base();
    local.info.description = 'LOCAL-ONLY-MARKER';
    local.item[0].item[0].request.body.raw = '{"address":"LOCAL-BODY-MARKER"}';
    local.item[0].item[0].response[0].body = '{"riskScore":"LOCAL-EXAMPLE-MARKER"}';
    const remote = base();
    remote.info.description = 'REMOTE-ONLY-MARKER';
    remote.item[0].item[0].request.body.raw = '{"address":"REMOTE-BODY-MARKER"}';
    remote.item[0].item[0].response[0].body = '{"riskScore":"REMOTE-EXAMPLE-MARKER"}';
    const out = render(safeDiff(local, remote));
    for (const marker of ['LOCAL-ONLY-MARKER', 'REMOTE-ONLY-MARKER', 'LOCAL-BODY-MARKER',
      'REMOTE-BODY-MARKER', 'LOCAL-EXAMPLE-MARKER', 'REMOTE-EXAMPLE-MARKER']) {
      assert.equal(out.includes(marker), false, `${marker} leaked into the diagnostic`);
    }
    // it still told the reviewer WHERE
    assert.match(out, /info\.description/);
    assert.match(out, /request\.body\.raw/);
  });

  test('header and variable VALUES never appear, only their keys', () => {
    const local = base();
    local.item[0].item[0].request.header[0].value = 'Bearer LOCAL-SECRET-VALUE';
    local.variable[0].value = 'LOCAL-VAR-VALUE';
    const remote = base();
    remote.item[0].item[0].request.header[0].value = 'Bearer REMOTE-SECRET-VALUE';
    remote.variable[0].value = 'REMOTE-VAR-VALUE';
    const out = render(safeDiff(local, remote));
    for (const v of ['LOCAL-SECRET-VALUE', 'REMOTE-SECRET-VALUE', 'LOCAL-VAR-VALUE', 'REMOTE-VAR-VALUE']) {
      assert.equal(out.includes(v), false);
    }
    assert.match(out, /header\[Authorization\]\.value/);
    assert.match(out, /variable\[base_url\]\.value/);
  });
});

describe('SAFE_DIFF_NO_SECRET_LEAK', () => {
  /*
   * Assembled at run time from harmless parts, for two reasons. The values must be
   * secret-SHAPED for this suite to mean anything, but a literal in the file would trip the
   * workflow's own secret-shape scan — and must obviously never resemble a real credential.
   * Concatenation keeps the runtime shape exact while leaving no matchable literal on disk.
   */
  const secrets = [
    ['PMAK', 'NOTAREALKEY0123456789'].join('-'),
    ['ocr', 'live', 'NOTAREALKEYdeadbeefcafe'].join('_'),
    `Bearer ${['ey', 'J0ZXN0Ijoibm90LWEtcmVhbC10b2tlbiJ9'].join('')}`,
    ['ey', 'J0ZXN0Ijoibm90LWEtcmVhbC10b2tlbiJ9'].join(''),
  ];

  test('every fixture really is secret-shaped, so the suite is not vacuous', () => {
    const SHAPES = /PMAK-[A-Za-z0-9]{6,}|ocr_(live|test|sandbox)_[A-Za-z0-9]{6,}|eyJ[A-Za-z0-9_-]{15,}|\bBearer\s+\S{6,}/;
    for (const v of secrets) assert.match(v, SHAPES, `${v.slice(0, 8)}… must look like a credential`);
  });

  test('no secret-shaped LITERAL exists in this test file', async () => {
    const { readFileSync } = await import('node:fs');
    const self = readFileSync(new URL('./postman-safe-diff.test.mjs', import.meta.url), 'utf8');
    const SCAN = /PMAK-[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{20,}|ocr_(live|test|sandbox)_[A-Za-z0-9]{12,}/;
    assert.equal(SCAN.test(self), false, 'the workflow secret-shape scan must stay clean');
  });

  test('secret-shaped VALUES cannot reach the output', () => {
    for (const secret of secrets) {
      const local = base();
      const remote = base();
      remote.item[0].item[0].request.header[0].value = secret;
      remote.variable[0].value = secret;
      remote.info.description = secret;
      const out = render(safeDiff(local, remote));
      assert.equal(out.includes(secret), false, `${secret.slice(0, 10)}… leaked`);
    }
  });

  test('secret-shaped LABELS are fingerprinted, not echoed', () => {
    for (const secret of secrets) {
      const local = base();
      const remote = base();
      remote.variable.push({ key: secret, value: 'x' });
      remote.item[0].item[0].response.push({ name: secret, code: 200, body: '{}' });
      const out = render(safeDiff(local, remote));
      assert.equal(out.includes(secret), false, `${secret.slice(0, 10)}… leaked as a label`);
      assert.match(out, /<redacted .*sha256:[0-9a-f]{8}>/);
    }
  });

  test('safeLabel redacts each secret shape and is deterministic', () => {
    for (const secret of secrets) {
      const a = safeLabel(secret);
      assert.equal(a.includes(secret), false);
      assert.match(a, /^<redacted label sha256:[0-9a-f]{8}>$/);
      assert.equal(a, safeLabel(secret), 'same input, same fingerprint');
    }
  });

  test('safeLabel keeps an ordinary label and marks truncation', () => {
    assert.equal(safeLabel('Analysis'), 'Analysis');
    assert.equal(safeLabel(''), '<no label>');
    assert.equal(safeLabel(undefined, { kind: 'folder name' }), '<no folder name>');
    // a 200-char run of one character is blob-shaped and is correctly redacted instead; use
    // ordinary prose to exercise the truncation path
    const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    assert.equal(long.length > 80, true);
    const out = safeLabel(long);
    assert.match(out, new RegExp(`…<truncated ${long.length}>$`));
    assert.equal(out.length < 120, true);
  });

  test('a long hex or base64 blob in a label is treated as secret-shaped', () => {
    assert.match(safeLabel('a'.repeat(40)), /<redacted/);
    assert.match(safeLabel('0123456789abcdef0123456789abcdef0123'), /<redacted/);
  });
});

describe('SAFE_DIFF_NO_IDS', () => {
  test('managed ids and uids never appear, because the diff runs on normalized copies', () => {
    const local = base();
    const remote = base();
    remote.info._postman_id = 'CLOUD-ID-MARKER';
    remote.info.uid = 'OWNER-UID-MARKER';
    remote.info.updatedAt = 'TIMESTAMP-MARKER';
    remote.item[0].id = 'FOLDER-ID-MARKER';
    remote.item[0].uid = 'FOLDER-UID-MARKER';
    remote.item[0].createdAt = 'ITEM-TIMESTAMP-MARKER';
    remote.item[0].item[0].id = 'REQUEST-ID-MARKER';
    remote.item[0].item[0].response[0].id = 'EXAMPLE-ID-MARKER';
    remote.item[0].item[0].event[0].script.id = 'SCRIPT-ID-MARKER';
    const d = safeDiff(local, remote);
    const out = render(d);
    for (const m of ['CLOUD-ID-MARKER', 'OWNER-UID-MARKER', 'TIMESTAMP-MARKER', 'FOLDER-ID-MARKER',
      'FOLDER-UID-MARKER', 'ITEM-TIMESTAMP-MARKER', 'REQUEST-ID-MARKER', 'EXAMPLE-ID-MARKER', 'SCRIPT-ID-MARKER']) {
      assert.equal(out.includes(m), false, `${m} leaked`);
    }
    // managed-only drift is no drift at all
    assert.deepEqual(d, { added: [], removed: [], changed: [] });
  });
});

describe('SAFE_DIFF_DETERMINISTIC', () => {
  test('the same inputs produce the same ordered output every time', () => {
    const local = base();
    const remote = base();
    remote.info.description = 'edited';
    remote.item[0].item[0].request.description = 'added';
    remote.variable[0].value = 'changed';
    delete remote.item[0].item[0].response;
    const runs = Array.from({ length: 5 }, () => render(safeDiff(local, remote)));
    assert.equal(new Set(runs).size, 1, 'output must be stable across runs');
  });

  test('paths are sorted and de-duplicated', () => {
    const local = base();
    local.item.push({ name: 'Zeta', item: [] }, { name: 'Alpha', item: [] });
    const remote = base();
    const d = safeDiff(local, remote);
    assert.deepEqual(d.added, ['item[Alpha]', 'item[Zeta]']);
    assert.equal(new Set(d.added).size, d.added.length);
  });

  test('key insertion order in the input does not change the output', () => {
    const remote = base();
    remote.info = { schema: remote.info.schema, description: 'edited', name: 'C' };   // reordered
    const a = render(safeDiff(base(), remote));
    const reordered = base();
    reordered.info = { description: reordered.info.description, name: 'C', schema: reordered.info.schema };
    const b = render(safeDiff(reordered, remote));
    assert.equal(a, b);
  });

  test('the render caps long lists and says how many were omitted', () => {
    const local = base();
    for (let i = 0; i < 50; i++) local.item.push({ name: `F${String(i).padStart(2, '0')}`, item: [] });
    const out = render(safeDiff(local, base()), { max: 5 });
    assert.match(out, /added {3}: 50/);
    assert.equal((out.match(/item\[F\d\d\]/g) ?? []).length, 5);
    assert.match(out, /…and 45 more/);
  });
});

describe('SAFE_DIFF_NOOP_SILENT and the printing rule', () => {
  test('an empty diff renders counts of zero and no path sections', () => {
    const out = render(safeDiff(base(), base()));
    assert.match(out, /added {3}: 0/);
    assert.equal(out.includes('added paths:'), false);
    assert.equal(out.includes('changed paths:'), false);
  });

  test('the driver prints a diff only on UPDATE', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../postman-sync.mjs', import.meta.url), 'utf8');
    const noop = src.indexOf("remote already matches the reviewed local file");
    const diffCall = src.indexOf('formatSafeDiff(safeDiff(local, remote)');
    const ret = src.indexOf('return { role: entry.role, action, put: false, verified: true');
    assert.equal(noop > -1 && diffCall > -1 && ret > -1, true);
    assert.equal(ret < diffCall, true, 'the NOOP branch must return BEFORE the diff is printed');
  });
});

describe('SAFE_DIFF_DOES_NOT_CHANGE_HASH', () => {
  test('both real collections still hash to their pre-change values', () => {
    const expected = {
      'paid-collection.json': '9f53729038e773eac00f94ab8b9b691ea482a1c90a24702c6877c0115ad296e4',
      'onchainrisk_sandbox_api_collection.json': 'b1a89ffcbca4c7df72dbbfc291b8bbc7f92f22e359455aa81412dc673c48799f',
    };
    for (const [file, hash] of Object.entries(expected)) {
      assert.equal(contentHash(readLocal(file)), hash, `${file} hash must be byte-for-byte unchanged`);
    }
  });

  test('computing a diff does not mutate either input', () => {
    for (const entry of COLLECTIONS) {
      const local = readLocal(entry.file);
      const remote = readLocal(entry.file);
      const before = JSON.stringify(local);
      remote.info.description = 'drifted';
      safeDiff(local, remote);
      assert.equal(JSON.stringify(local), before, 'local must be untouched');
      assert.equal(contentHash(readLocal(entry.file)), contentHash(local));
    }
  });

  test('the diff agrees with the NOOP/UPDATE decision', () => {
    for (const entry of COLLECTIONS) {
      const local = readLocal(entry.file);
      // managed-only remote: UPDATE must not be reported, and the diff must be empty
      const managedOnly = { collection: JSON.parse(JSON.stringify(local)) };
      managedOnly.collection.info._postman_id = 'cloud';
      managedOnly.collection.info.updatedAt = '2026-10-11T00:00:00.000Z';
      let i = 0;
      const walk = (nodes) => {
        for (const x of nodes ?? []) {
          x.id = `i-${i++}`; x.createdAt = '2026-01-01T00:00:00.000Z';
          for (const r of x.response ?? []) { r.id = `x-${i++}`; r.updatedAt = '2026-01-01T00:00:00.000Z'; }
          if (x.item) walk(x.item);
        }
      };
      walk(managedOnly.collection.item);
      assert.equal(contentHash(local), contentHash(managedOnly), `${entry.file} must be a NOOP`);
      assert.deepEqual(safeDiff(local, managedOnly), { added: [], removed: [], changed: [] });
    }
  });
});


// R1 - EVERY path component goes through one safety policy.
//
// Three surfaces previously bypassed the renderer: the normalized URL path, the HTTP method, and
// arbitrary object property keys. Each could put a credential, or a forged log line, into an
// Actions log. Secret-shaped fixtures are assembled at run time so the repository secret-shape
// scan stays meaningful, and control characters are produced with String.fromCharCode, so this
// file holds no literal control byte.

describe('R1 - path-component sanitisation is universal', () => {
  const SECRET_PATH_SEG = ['PMAK', 'URLSEGMENT0123456789'].join('-');
  const SECRET_KEY = ['ocr', 'live', 'OBJECTKEY0123456789abc'].join('_');
  const ch = (n) => String.fromCharCode(n);

  /** True if any character could forge a log line or drive a terminal. */
  const hasControl = (s) => [...String(s)].some((c) => {
    const n = c.charCodeAt(0);
    return n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029;
  });

  const withUrl = (raw) => ({
    info: { name: 'C', description: 'prose' },
    item: [{
      name: 'Analysis',
      item: [{ name: 'R', request: { method: 'POST', url: { raw }, description: 'd' }, response: [] }],
    }],
  });

  const lines = (a, b) => {
    const acc = [];
    formatSafeDiff(safeDiff(a, b), { log: (l) => acc.push(String(l)) });
    return acc;
  };
  const out = (a, b) => lines(a, b).join(ch(10));

  test('SAFE_DIFF_SECRET_IN_URL_PATH_REDACTED', () => {
    const local = withUrl(`{{base_url}}/api/${SECRET_PATH_SEG}/x`);
    const remote = withUrl(`{{base_url}}/api/${SECRET_PATH_SEG}/x`);
    remote.item[0].item[0].request.description = 'drifted';
    const text = out(local, remote);
    assert.equal(text.includes(SECRET_PATH_SEG), false, 'the secret path segment must not appear');
    assert.match(text, /<redacted path segment sha256:[0-9a-f]{8}>/);
    assert.match(text, /POST \/api\/<redacted path segment sha256:[0-9a-f]{8}>\/x/);
  });

  test('a secret-shaped HTTP method is redacted too', () => {
    const weird = ['PMAK', 'METHOD0123456789abcd'].join('-');
    const local = withUrl('{{base_url}}/api/v1/check');
    local.item[0].item[0].request.method = weird;
    const remote = JSON.parse(JSON.stringify(local));
    remote.item[0].item[0].request.description = 'drifted';
    const text = out(local, remote);
    assert.equal(text.includes(weird), false);
    assert.match(text, /<redacted method sha256:[0-9a-f]{8}>/);
  });

  test('a non-secret but implausible method is still not echoed raw', () => {
    const local = withUrl('{{base_url}}/api/v1/check');
    local.item[0].item[0].request.method = 'GET /etc/passwd; rm -rf';
    const remote = JSON.parse(JSON.stringify(local));
    remote.item[0].item[0].request.description = 'drifted';
    assert.equal(out(local, remote).includes('rm -rf'), false, 'only a plain verb may render literally');
  });

  test('SAFE_DIFF_SECRET_OBJECT_KEY_REDACTED', () => {
    const local = withUrl('{{base_url}}/api/v1/check');
    const remote = JSON.parse(JSON.stringify(local));
    remote.item[0].item[0].request[SECRET_KEY] = 'value';
    const text = out(local, remote);
    assert.equal(text.includes(SECRET_KEY), false, 'a secret-shaped property key must not appear');
    assert.match(text, /<key sha256:[0-9a-f]{8}>/);
  });

  test('SAFE_DIFF_UNKNOWN_OBJECT_KEY_SAFE', () => {
    const local = withUrl('{{base_url}}/api/v1/check');
    const remote = JSON.parse(JSON.stringify(local));
    remote.item[0].item[0].request.customerInternalFieldName = 'value';
    const text = out(local, remote);
    assert.equal(text.includes('customerInternalFieldName'), false, 'an unknown key is fingerprinted, not echoed');
    assert.match(text, /request\.<key sha256:[0-9a-f]{8}>/);
  });

  test('safeKey is literal for schema keys and fingerprinted otherwise, deterministically', () => {
    for (const k of ['info', 'description', 'request', 'response', 'body', 'script', 'exec', 'header', 'variable']) {
      assert.equal(safeKey(k), k, `${k} is schema structure and should read literally`);
    }
    for (const k of ['somethingArbitrary', SECRET_KEY, 'X-Customer-Field']) {
      const a = safeKey(k);
      assert.match(a, /^<key sha256:[0-9a-f]{8}>$/);
      assert.equal(a, safeKey(k), 'same key, same fingerprint');
      assert.equal(a.includes(k), false);
    }
  });

  test('SAFE_DIFF_CONTROL_CHARS_SAFE', () => {
    const payloads = [
      `line1${ch(10)}INJECTED-LINE`,
      `line1${ch(13)}${ch(10)}INJECTED-LINE`,
      `tab${ch(9)}here`,
      `${ch(27)}[31mANSI-RED${ch(27)}[0m`,
      `sep${ch(0x2028)}INJECTED-LINE`,
      `nul${ch(0)}byte`,
      `bell${ch(7)}here`,
      `del${ch(127)}char`,
      `c1${ch(0x9b)}next`,
    ];
    for (const [i, payload] of payloads.entries()) {
      const local = withUrl('{{base_url}}/api/v1/check');
      const remote = JSON.parse(JSON.stringify(local));
      remote.item[0].name = payload;
      const emitted = lines(local, remote);
      for (const line of emitted) {
        assert.equal(hasControl(line), false, `payload ${i} left a control character in the output`);
        assert.equal(/^\s*(INJECTED-LINE|ANSI-RED)/.test(line), false, `payload ${i} forged a log line`);
      }
    }
  });

  test('control characters are neutralised before truncation or redaction can hide them', () => {
    assert.equal(hasControl(safeComponent(`a${ch(10)}b`)), false);
    assert.equal(safeComponent(`a${ch(10)}b`).length, 3, 'the newline becomes one visible placeholder');
    assert.equal(hasControl(safeComponent(`x${ch(10)}${'y '.repeat(60)}`)), false);
    const split = ['PMAK', 'SPLITKEY0123456789ab'].join('-');
    assert.match(safeComponent(`${split}${ch(10)}`), /^<redacted label sha256:[0-9a-f]{8}>$/);
  });

  test('SAFE_DIFF_NORMAL_ROUTE_READABLE', () => {
    const local = withUrl('{{base_url}}/api/v1/check');
    const remote = JSON.parse(JSON.stringify(local));
    remote.item[0].item[0].request.description = 'drifted';
    const text = out(local, remote);
    assert.match(text, /item\[Analysis\]\.item\[POST \/api\/v1\/check\]\.request\.description/);
    assert.equal(text.includes('<key'), false, 'a normal route needs no fingerprints');
    assert.equal(text.includes('<redacted'), false);
  });

  test('safePath and safeMethod keep ordinary routes readable', () => {
    assert.equal(safePath({ raw: '{{base_url}}/api/labels/{{sample_label_id}}' }), '/api/labels/{var}');
    assert.equal(safePath({ raw: '{{base_url}}/api/v1/check?network=eth' }), '/api/v1/check');
    assert.equal(safePath({ raw: '' }), '');
    assert.equal(safeMethod('post'), 'POST');
    assert.equal(safeMethod(''), '');
  });

  test('the REAL collections render with no fingerprinted component at all', () => {
    for (const entry of COLLECTIONS) {
      const local = readLocal(entry.file);
      const remote = JSON.parse(JSON.stringify(local));
      remote.info.description = 'drifted';
      const walk = (nodes) => {
        for (const x of nodes ?? []) {
          if (x.request) x.request.description = 'drifted';
          for (const r of x.response ?? []) r.code = 599;
          if (x.item) walk(x.item);
        }
      };
      walk(remote.item);
      const d = safeDiff(local, remote);
      const all = [...d.added, ...d.removed, ...d.changed];
      assert.equal(all.length > 0, true, `${entry.file} should show drift`);
      for (const p of all) {
        assert.equal(p.includes('<key '), false, `${entry.file}: unexpected fingerprinted key in ${p}`);
        assert.equal(p.includes('<redacted'), false, `${entry.file}: unexpected redaction in ${p}`);
        assert.equal(p.includes('<no '), false, `${entry.file}: unexpected empty label in ${p}`);
        assert.equal(hasControl(p), false, `${entry.file}: control char in ${p}`);
      }
    }
  });

  test('the renderer no longer reaches a raw method, path or key', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../postman-sync.mjs', import.meta.url), 'utf8');
    assert.match(src, /const method = safeMethod\(node\.request\?\.method\)/);
    assert.match(src, /const path = safePath\(node\.request\?\.url\)/);
    assert.match(src, /const rendered = safeKey\(k\)/);
  });
});
