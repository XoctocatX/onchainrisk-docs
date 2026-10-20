/**
 * Post-write canonicalization: Postman's serialization vs our authored content.
 *
 * The first real publish issued its PUT, Postman accepted the intended canonical content, and
 * the run then correctly STOPped because the post-write GET did not hash-match the local file.
 * Every remaining difference was Postman's serializer rather than content:
 *
 *   - `responseTime` on each saved response example — the latency of the capture;
 *   - `response: []` on each request with no saved examples, where a hand-authored collection
 *     simply omits the optional field.
 *
 * When that run stopped, the paid collection had 39 requests with no authored examples and 19
 * saved examples, so the authoritative read-only verify reported exactly 39 + 19 = 58 normalized
 * paths. That 58 is a record of THAT incident, not a property of the collection: the published
 * paid surface has since changed, and the CURRENT reviewed shape is pinned in
 * POST_WRITE_SHAPE_REGRESSION below. Both fields are normalized for COMPARISON only. The six
 * invariants below are what keeps that narrow.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COLLECTIONS, MANAGED_FIELDS,
  contentHash, semanticallyEqual, normalizeForCompare, stripManaged,
  buildIdentityMap, injectRemoteIds, readLocal, safeDiff,
} from '../postman-sync.mjs';

const { IDENTITY, SERVER_METADATA, MANAGED } = MANAGED_FIELDS;

const clone = (x) => JSON.parse(JSON.stringify(x));

/** A minimal authored collection: one folder, one request with an example, one without. */
function canonical() {
  return {
    info: {
      _postman_id: 'cccccccc-1111-2222-3333-444444444444',
      name: 'Fixture',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'Folder',
        item: [
          {
            // Authored WITH a saved example, and that example has no responseTime.
            name: 'POST /api/v1/check',
            request: {
              method: 'POST',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: { mode: 'raw', raw: '{"address":"0xabc"}' },
              url: { raw: '{{base_url}}/api/v1/check', host: ['{{base_url}}'], path: ['api', 'v1', 'check'] },
            },
            response: [
              {
                name: '200 ok',
                code: 200,
                status: 'OK',
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: '{"success":true}',
              },
            ],
          },
          {
            // Authored WITHOUT the optional `response` field at all.
            name: 'GET /api/v1/usage',
            request: {
              method: 'GET',
              header: [],
              url: { raw: '{{base_url}}/api/v1/usage', host: ['{{base_url}}'], path: ['api', 'v1', 'usage'] },
            },
          },
        ],
      },
    ],
  };
}

/** Walk every leaf request item. */
function requests(collection) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (Array.isArray(n.item)) walk(n.item);
      else out.push(n);
    }
  };
  walk(collection.item);
  return out;
}

/** The same collection as Postman serializes it back after a write. */
function asPostmanReturnsIt(local, { responseTime = 123 } = {}) {
  const remote = clone(local);
  for (const r of requests(remote)) {
    if (!Array.isArray(r.response)) r.response = [];
    for (const ex of r.response) ex.responseTime = responseTime;
  }
  return remote;
}

const find = (collection, name) => requests(collection).find((r) => r.name === name);

// ───────────────── 1. responseTime is positional, at the saved example only ─────────────────

describe('RESPONSE_TIME_POSITIONAL_NORMALIZATION', () => {
  test('responseTime is modelled at the response-example position and nowhere else', () => {
    assert.equal(SERVER_METADATA.response.includes('responseTime'), true);
    for (const kind of Object.keys(MANAGED)) {
      if (kind === 'response') continue;
      assert.equal(
        (MANAGED[kind] ?? []).includes('responseTime'), false,
        `responseTime must not be managed at position "${kind}"`,
      );
    }
  });

  test('it is server metadata, not identity, so it is never echoed back', () => {
    assert.equal(IDENTITY.response.includes('responseTime'), false);
  });

  test('SERVER_METADATA.response is pinned exhaustively, so widening it stays deliberate', () => {
    assert.deepEqual(SERVER_METADATA.response, ['createdAt', 'updatedAt', 'responseTime']);
  });

  test('a remote differing only by example responseTime is a semantic NOOP', () => {
    const local = canonical();
    const remote = clone(local);
    find(remote, 'POST /api/v1/check').response[0].responseTime = 456;
    assert.equal(semanticallyEqual(local, remote), true);
    assert.equal(contentHash(local), contentHash(remote));
  });

  test('normalizeForCompare actually removes it from the example', () => {
    const remote = clone(canonical());
    find(remote, 'POST /api/v1/check').response[0].responseTime = 456;
    const normalized = normalizeForCompare(remote);
    assert.equal('responseTime' in find(normalized, 'POST /api/v1/check').response[0], false);
  });

  test('a differing responseTime does not even appear in the safe diff', () => {
    const local = canonical();
    const remote = clone(local);
    find(remote, 'POST /api/v1/check').response[0].responseTime = 999;
    const d = safeDiff(local, remote);
    assert.deepEqual([d.added.length, d.removed.length, d.changed.length], [0, 0, 0]);
  });
});

// ───────────────── 2. absent `response` ≡ `response: []` ─────────────────

describe('ABSENT_VS_EMPTY_RESPONSE_EQUIVALENCE', () => {
  test('a remote that adds response: [] to an example-less request is a NOOP', () => {
    const local = canonical();
    const remote = clone(local);
    find(remote, 'GET /api/v1/usage').response = [];
    assert.equal(semanticallyEqual(local, remote), true);
  });

  test('the equivalence holds in BOTH directions', () => {
    // The real paid collection authors `response: []` explicitly on three requests, so the
    // local side can be the one carrying the empty array.
    const withEmpty = canonical();
    find(withEmpty, 'GET /api/v1/usage').response = [];
    const withAbsent = canonical();
    assert.equal(contentHash(withEmpty), contentHash(withAbsent));
    assert.equal(contentHash(withAbsent), contentHash(withEmpty));
  });

  test('an empty array is REMOVED by normalization, never added', () => {
    const n1 = normalizeForCompare(canonical());
    assert.equal('response' in find(n1, 'GET /api/v1/usage'), false, 'absent stays absent');

    const withEmpty = canonical();
    find(withEmpty, 'GET /api/v1/usage').response = [];
    const n2 = normalizeForCompare(withEmpty);
    assert.equal('response' in find(n2, 'GET /api/v1/usage'), false, 'empty is dropped');
  });

  test('a folder is not a request item: its arrays are left alone', () => {
    // A folder has no `response` in v2.1; the rule is scoped to requests so that it cannot
    // reach into some other node's optional fields.
    const local = canonical();
    const remote = clone(local);
    remote.item[0].response = [];
    assert.equal(semanticallyEqual(local, remote), false);
  });

  test('an unrelated empty array elsewhere is untouched content', () => {
    const local = canonical();
    const remote = clone(local);
    find(remote, 'GET /api/v1/usage').request.header = undefined;
    delete find(remote, 'GET /api/v1/usage').request.header;
    assert.equal(semanticallyEqual(local, remote), false, 'an empty header[] is not a response[]');
  });
});

// ───────────────── 3. a non-empty response array is content ─────────────────

describe('NONEMPTY_RESPONSE_REMAINS_CONTENT', () => {
  test('NEGATIVE CONTROL — a remote-only non-empty saved example makes hashes differ', () => {
    const local = canonical();
    const remote = clone(local);
    find(remote, 'GET /api/v1/usage').response = [
      { name: '200 usage', code: 200, status: 'OK', header: [], body: '{"used":1}' },
    ];
    assert.equal(semanticallyEqual(local, remote), false);
    const d = safeDiff(local, remote);
    assert.equal(d.removed.length > 0, true, 'the extra example must be reported as a path');
  });

  test('NEGATIVE CONTROL — a materially changed saved example body makes hashes differ', () => {
    const local = canonical();
    const remote = clone(local);
    find(remote, 'POST /api/v1/check').response[0].body = '{"success":false}';
    assert.equal(semanticallyEqual(local, remote), false);
  });

  test('the example name, code and headers all still participate', () => {
    for (const mutate of [
      (ex) => { ex.name = '200 renamed'; },
      (ex) => { ex.code = 201; },
      (ex) => { ex.status = 'Created'; },
      (ex) => { ex.header = [{ key: 'X-Added', value: '1' }]; },
    ]) {
      const local = canonical();
      const remote = clone(local);
      mutate(find(remote, 'POST /api/v1/check').response[0]);
      assert.equal(semanticallyEqual(local, remote), false);
    }
  });

  test('an example reduced to {} by stripping is still a non-empty array, so it differs', () => {
    // A remote example consisting ONLY of managed keys normalizes to {} — one entry, not zero.
    // That is a real difference from a request with no examples and must not be hidden.
    const local = canonical();
    const remote = clone(local);
    find(remote, 'GET /api/v1/usage').response = [{ id: 'remote-example-id' }];
    assert.equal(semanticallyEqual(local, remote), false);
  });

  test('dropping a locally authored example is reported, not normalized away', () => {
    const local = canonical();
    const remote = clone(local);
    find(remote, 'POST /api/v1/check').response = [];
    assert.equal(semanticallyEqual(local, remote), false);
  });
});

// ───────────────── 4. `responseTime` by name, anywhere else, is content ─────────────────

describe('ARBITRARY_RESPONSE_TIME_REMAINS_CONTENT', () => {
  const positions = {
    'on the request item': (c) => { find(c, 'GET /api/v1/usage').responseTime = 10; },
    'on the request object': (c) => { find(c, 'GET /api/v1/usage').request.responseTime = 10; },
    'on a folder': (c) => { c.item[0].responseTime = 10; },
    'on collection info': (c) => { c.info.responseTime = 10; },
    'on an event script': (c) => {
      find(c, 'GET /api/v1/usage').event = [
        { listen: 'test', script: { type: 'text/javascript', exec: ['//'], responseTime: 10 } },
      ];
    },
    'nested one level below a saved example': (c) => {
      find(c, 'POST /api/v1/check').response[0].originalRequest = { responseTime: 10 };
    },
    'inside a saved example header list': (c) => {
      find(c, 'POST /api/v1/check').response[0].header.push({ key: 'responseTime', value: '10' });
    },
  };

  for (const [where, mutate] of Object.entries(positions)) {
    test(`NEGATIVE CONTROL — responseTime ${where} is content and changes the hash`, () => {
      const local = canonical();
      const remote = clone(local);
      mutate(remote);
      assert.equal(semanticallyEqual(local, remote), false, `responseTime ${where} must survive`);
    });
  }

  test('NEGATIVE CONTROL — an arbitrary nested business object keeps its responseTime', () => {
    const local = canonical();
    const remote = clone(local);
    // A plausible business payload that happens to use the same key name.
    find(remote, 'GET /api/v1/usage').request.body = {
      mode: 'raw',
      raw: JSON.stringify({ sla: { responseTime: 250, unit: 'ms' } }),
    };
    assert.equal(semanticallyEqual(local, remote), false);

    const normalized = normalizeForCompare(remote);
    assert.match(find(normalized, 'GET /api/v1/usage').request.body.raw, /responseTime/);
  });

  test('a responseTime in an example BODY string survives normalization', () => {
    const remote = clone(canonical());
    find(remote, 'POST /api/v1/check').response[0].body = '{"responseTime":250}';
    const normalized = normalizeForCompare(remote);
    assert.match(find(normalized, 'POST /api/v1/check').response[0].body, /responseTime/);
  });
});

// ───────────────── 5. the outbound payload is untouched ─────────────────

describe('OUTBOUND_PAYLOAD_UNCHANGED', () => {
  test('the payload is built from stripManaged, NOT from normalizeForCompare', () => {
    // Structural guarantee: the comparison-only canonicalization lives in normalizeForCompare,
    // so it cannot reach the PUT body. Asserted on the source because that separation is the
    // whole safety argument.
    const src = readFileSync(new URL('../postman-sync.mjs', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export function injectRemoteIds'), src.indexOf('export function identityConsistent'));
    assert.match(fn, /stripManaged\(local\)/);
    assert.equal(fn.includes('normalizeForCompare'), false, 'injectRemoteIds must not normalize for compare');
    assert.equal(fn.includes('dropEmptyResponseArrays'), false);
  });

  test('stripManaged does NOT drop an empty response array', () => {
    const local = canonical();
    find(local, 'GET /api/v1/usage').response = [];
    const stripped = stripManaged(local);
    assert.deepEqual(find(stripped, 'GET /api/v1/usage').response, [], 'the payload keeps what was authored');
  });

  test('a locally authored response: [] survives into the payload verbatim', () => {
    const local = canonical();
    find(local, 'GET /api/v1/usage').response = [];
    const remote = asPostmanReturnsIt(local);
    const payload = injectRemoteIds(local, buildIdentityMap(remote));
    assert.deepEqual(find(payload, 'GET /api/v1/usage').response, []);
  });

  test('an absent response stays absent in the payload — no empty array is injected', () => {
    const local = canonical();
    const remote = asPostmanReturnsIt(local);           // remote HAS response: []
    const payload = injectRemoteIds(local, buildIdentityMap(remote));
    assert.equal('response' in find(payload, 'GET /api/v1/usage'), false);
  });

  test('a remote responseTime is never injected into the payload', () => {
    const local = canonical();
    const remote = asPostmanReturnsIt(local, { responseTime: 777 });
    const payload = injectRemoteIds(local, buildIdentityMap(remote));
    const ex = find(payload, 'POST /api/v1/check').response[0];
    assert.equal('responseTime' in ex, false);
    assert.equal(JSON.stringify(payload).includes('777'), false, 'no server metadata echoed anywhere');
  });

  test('the real collections produce a payload with no responseTime and no added arrays', () => {
    for (const entry of COLLECTIONS) {
      const local = readLocal(entry.file);
      const remote = asPostmanReturnsIt(clone(local));
      const payload = injectRemoteIds(local, buildIdentityMap(remote));
      for (const r of requests(payload)) {
        for (const ex of r.response ?? []) {
          assert.equal('responseTime' in ex, false, `${entry.file}: ${r.name} example echoed responseTime`);
        }
      }
      // Exactly the requests that authored a `response` key still have one.
      const authored = requests(local).filter((r) => 'response' in r).map((r) => r.name).sort();
      const out = requests(payload).filter((r) => 'response' in r).map((r) => r.name).sort();
      assert.deepEqual(out, authored, `${entry.file}: the payload's response keys must match the file's`);
    }
  });
});

// ───────────────── 6. protocolProfileBehavior normalization is NOT broadened ─────────────────

describe('PROTOCOL_PROFILE_BEHAVIOR_NOT_BROADENED', () => {
  test('it is modelled at no position, in neither identity nor server metadata', () => {
    for (const kind of Object.keys(MANAGED)) {
      assert.equal((MANAGED[kind] ?? []).includes('protocolProfileBehavior'), false, kind);
    }
    assert.equal(JSON.stringify(SERVER_METADATA).includes('protocolProfileBehavior'), false);
    assert.equal(JSON.stringify(IDENTITY).includes('protocolProfileBehavior'), false);
  });

  test('a remote-only protocolProfileBehavior still reports drift', () => {
    const local = canonical();
    const remote = clone(local);
    find(remote, 'GET /api/v1/usage').protocolProfileBehavior = { disableBodyPruning: true };
    assert.equal(semanticallyEqual(local, remote), false);
    assert.equal(safeDiff(local, remote).removed.length > 0, true);
  });
});

// ───────────────── the real post-PUT regression fixture ─────────────────

describe('POST_WRITE_SHAPE_REGRESSION', () => {
  test('the fixture shape from the stopped publish now hash-matches', () => {
    // Canonical: a request with NO response, and a saved example with NO responseTime.
    // Remote:    the same request with response: [], the same example with responseTime.
    const local = canonical();
    assert.equal('response' in find(local, 'GET /api/v1/usage'), false);
    assert.equal('responseTime' in find(local, 'POST /api/v1/check').response[0], false);

    const remote = clone(local);
    find(remote, 'GET /api/v1/usage').response = [];
    find(remote, 'POST /api/v1/check').response[0].responseTime = 41;

    assert.equal(contentHash(local), contentHash(remote), 'the post-write shape must verify');
  });

  test('on the REAL collections, the post-write shape verifies and the diff is empty', () => {
    for (const entry of COLLECTIONS) {
      const local = readLocal(entry.file);
      const remote = asPostmanReturnsIt(clone(local));
      assert.equal(contentHash(local), contentHash(remote), `${entry.file} must verify after a write`);
      const d = safeDiff(local, remote);
      assert.deepEqual(
        [d.added.length, d.removed.length, d.changed.length], [0, 0, 0],
        `${entry.file} must report no drift`,
      );
    }
  });

  test('the paid collection has the CURRENT reviewed serialization shape', () => {
    // WHAT THIS PINS, and why the number here is not the 58 in the file header.
    //
    // The 58 belonged to one incident: when the first publish stopped, the paid collection had
    // 39 absent `response` keys + 19 saved examples. The published paid surface has changed since
    // (45 requests today, not 46), so re-deriving 58 from the live file would be impossible and
    // asserting it anyway would be a fixture that lies. This test is therefore about the CURRENT
    // reviewed shape, and the arithmetic is spelled out so a future change has to be re-derived
    // and re-reviewed rather than silently absorbed:
    //
    //   45 requests · 19 saved examples · 38 with `response` ABSENT · 3 authored `response: []`
    //   => 41 requests carry no examples (38 + 3)
    //   => 38 + 19 = 57 paths the comparator normalizes
    //
    // Independently derived from the committed collection, not copied from a CI log.
    const local = readLocal(COLLECTIONS.find((c) => c.role === 'paid').file);
    const rs = requests(local);
    const absent = rs.filter((r) => !('response' in r));
    const emptyArrays = rs.filter((r) => Array.isArray(r.response) && r.response.length === 0);
    const noExamples = rs.filter((r) => !Array.isArray(r.response) || r.response.length === 0);
    const examples = rs.reduce((n, r) => n + (r.response?.length ?? 0), 0);
    assert.equal(rs.length, 45, 'paid requests');
    assert.equal(examples, 19, 'saved examples');
    assert.equal(absent.length, 38, 'requests with the response key absent');
    assert.equal(emptyArrays.length, 3, 'requests with an authored empty response array');
    assert.equal(noExamples.length, 41, '38 absent + 3 authored empty arrays');
    assert.equal(absent.length + examples, 57, 'normalized serialization paths');
    // The two ways of counting "no examples" must agree — if they ever diverge, one of the two
    // categories above was mis-measured and the totals cannot be trusted.
    assert.equal(absent.length + emptyArrays.length, noExamples.length);
  });

  test('the HISTORICAL 58-path incident shape is still what the comparator normalizes', () => {
    // Option B of the repair, kept alongside option A: the incident is preserved as a FIXTURE,
    // decoupled from the live collection, so the historical claim in this file's header remains
    // demonstrable after the published surface moves again. It builds the 1-publish-era shape —
    // 39 requests with no authored examples plus 19 saved examples — and proves the comparator
    // still normalizes exactly those 58 paths to a matching hash.
    const local = { ...canonical(), item: [] };
    for (let i = 0; i < 39; i += 1) {
      local.item.push({ name: `GET /no-example/${i}`, request: { method: 'GET', url: { raw: `{{base_url}}/x/${i}` } } });
    }
    for (let i = 0; i < 19; i += 1) {
      local.item.push({
        name: `POST /with-example/${i}`,
        request: { method: 'POST', url: { raw: `{{base_url}}/y/${i}` } },
        response: [{ name: '200', code: 200, status: 'OK', body: '{}' }],
      });
    }
    const rs = requests(local);
    const absent = rs.filter((r) => !('response' in r)).length;
    const examples = rs.reduce((n, r) => n + (r.response?.length ?? 0), 0);
    assert.equal(absent, 39);
    assert.equal(examples, 19);
    assert.equal(absent + examples, 58, 'the shape the stopped run reported');

    // Now the part that matters: Postman's serializer adds `response: []` to each of the 39 and
    // `responseTime` to each of the 19, and the comparator must still hash-match.
    const remote = clone(local);
    for (const r of requests(remote)) {
      if (!('response' in r)) r.response = [];
      else for (const ex of r.response) ex.responseTime = 41;
    }
    assert.equal(contentHash(local), contentHash(remote), 'all 58 paths must normalize away');
    const d = safeDiff(local, remote);
    assert.deepEqual([d.added.length, d.removed.length, d.changed.length], [0, 0, 0]);
  });
});
