/*
 * R5 — THE THREE SERIALIZATION CLASSES from the first real publish of the canonical collection.
 *
 * One PUT succeeded, the remote held all 45 requests, and the post-write verification failed
 * closed on 1 added / 15 removed / 10 changed paths. `safeDiff(local, remote)` walks local as
 * `a`, so ADDED is local-only and REMOVED is remote-only:
 *
 *   CLASS 1  added   `variable`                       -> local declares `variable: []`, the
 *                                                        remote omits an empty one
 *   CLASS 2  removed `request.url.variable[*].id` x15  -> Postman GENERATES a path-variable id
 *   CLASS 3  changed `request.url.raw` x10             -> Postman re-serializes `raw`, and those
 *                                                        ten are exactly the requests carrying
 *                                                        `disabled: true` query parameters
 *
 * Each class is reconciled differently and on purpose. The point of this suite is that genuine
 * drift in the same positions is STILL detected.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readLocal, contentHash, safeDiff, canonicalRawUrl, rawUrlConsistencyProblems, MANAGED_FIELDS,
} from '../postman-sync.mjs';

const COLLECTION = 'onchainrisk_api_collection.json';
const local = () => readLocal(COLLECTION);
const requests = (doc) => {
  const out = [];
  (function w(d) { for (const i of d.item ?? []) (Array.isArray(i.item) ? w(i) : out.push(i)); })(doc);
  return out;
};

/** The remote as the verify evidence describes it, derived from our own artifact. */
function asPostmanReturnsIt(doc) {
  const r = JSON.parse(JSON.stringify(doc));
  delete r.variable;                                    // CLASS 1
  let ids = 0;
  let raws = 0;
  for (const it of requests(r)) {
    const u = it.request?.url;
    if (!u) continue;
    for (const v of u.variable ?? []) { v.id = `pm-generated-${++ids}`; }   // CLASS 2
    if (typeof u.raw === 'string') {                                        // CLASS 3
      const enabled = (u.query ?? []).filter((q) => q.disabled !== true)
        .map((q) => `${q.key}=${q.value ?? ''}`);
      const rebuilt = `${u.host.join('.')}/${u.path.join('/')}`
        + (enabled.length ? `?${enabled.join('&')}` : '');
      if (rebuilt !== u.raw) raws += 1;
      u.raw = rebuilt;
    }
  }
  return { remote: r, generatedIds: ids, rewrittenRaws: raws };
}

describe('R5 — the observed drift is reproduced, then reconciled', () => {
  test('the simulated remote reproduces the EXACT reported counts', () => {
    const { generatedIds, rewrittenRaws } = asPostmanReturnsIt(local());
    // 15 removed and 10 changed, from run 40303538640
    assert.equal(generatedIds, 15, 'fifteen path variables carry a generated id');
    assert.equal(rewrittenRaws, 10, 'ten raw strings are rewritten — the ones with disabled query params');
  })

  test('all three classes together reconcile to a zero diff and an equal hash', () => {
    const l = local();
    const { remote } = asPostmanReturnsIt(l);
    const d = safeDiff(l, remote);
    assert.deepEqual(d, { added: [], removed: [], changed: [] });
    assert.equal(contentHash(l), contentHash(remote));
  })

  test('the ten rewritten raws are EXACTLY the requests with disabled query params', () => {
    // The correlation is what justifies deriving `raw` instead of guessing Postman's rule.
    const withDisabled = requests(local()).filter((i) =>
      (i.request?.url?.query ?? []).some((q) => q.disabled === true));
    assert.equal(withDisabled.length, 10);
    const { rewrittenRaws } = asPostmanReturnsIt(local());
    assert.equal(rewrittenRaws, withDisabled.length);
  })
})

describe('R5 CLASS 2 — url.variable[*].id is managed at that position and nowhere else', () => {
  test('it is SERVER_METADATA, not IDENTITY — so it is never echoed back', () => {
    assert.deepEqual(MANAGED_FIELDS.SERVER_METADATA.urlVariable, ['id']);
    assert.equal('urlVariable' in MANAGED_FIELDS.IDENTITY, false);
  })

  test('a generated id at that position is normalized away', () => {
    const l = local();
    const r = JSON.parse(JSON.stringify(l));
    for (const it of requests(r)) for (const v of it.request?.url?.variable ?? []) v.id = 'x';
    assert.equal(contentHash(l), contentHash(r));
  })

  test('PROOF — an `id` OUTSIDE that position still participates in the hash', () => {
    // Four content positions that a recursive strip would have silently eaten.
    const cases = {
      'request body': (doc) => {
        const it = requests(doc).find((x) => x.request?.body?.raw);
        it.request.body.raw = JSON.stringify({ id: 'content-id-in-a-body' });
      },
      'a new response example': (doc) => {
        requests(doc)[0].response = [{ name: 'ex', code: 200, id: 'example-identity' }];
      },
      'a url variable VALUE': (doc) => {
        const it = requests(doc).find((x) => x.request?.url?.variable?.length);
        it.request.url.variable[0].value = '{{something_else}}';
      },
      'a url variable KEY named id': (doc) => {
        const it = requests(doc).find((x) => x.request?.url?.variable?.length);
        it.request.url.variable[0].key = 'id';
      },
    };
    for (const [what, mutate] of Object.entries(cases)) {
      const l = local();
      const r = JSON.parse(JSON.stringify(l));
      mutate(r);
      assert.notEqual(contentHash(l), contentHash(r), `${what} must still change the hash`);
    }
  })

  /*
   * SYNTHETIC PROBE, and it exists because the four cases above did NOT catch the thing they
   * were written to catch. A mutation that added a recursive `delete o.id` to stripManaged
   * passed the entire suite: a body `id` lives inside a raw JSON STRING, a response example's
   * `id` is managed identity anyway, and a `{key: 'id'}` path variable carries `id` as a VALUE.
   * None of them is an `id` FIELD on an unmanaged object, which is precisely what a recursive
   * strip would eat. The real artifact has no such field today, so the probe is constructed —
   * the same approach the server-shape suite uses for `createdAt` inside example bodies.
   */
  test('PROOF — an `id` FIELD at an unmanaged object position survives normalization', () => {
    const synthetic = () => ({
      info: { name: 'OnChainRisk API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'base_url', value: 'https://x.test', id: 'authored-collection-variable-id' }],
      item: [{
        name: 'Folder',
        item: [{
          name: 'req',
          request: {
            method: 'GET',
            header: [{ key: 'X-Trace', value: '1', id: 'authored-header-id' }],
            body: {
              mode: 'formdata',
              formdata: [{ key: 'field', value: 'v', id: 'authored-formdata-id' }],
            },
            url: {
              raw: 'https://x.test/api/thing?q=1',
              host: ['https://x.test'],
              path: ['api', 'thing'],
              query: [{ key: 'q', value: '1', id: 'authored-query-id' }],
              variable: [],
            },
          },
        }],
      }],
    });
    const CONTENT_IDS = [
      'authored-collection-variable-id', 'authored-header-id',
      'authored-formdata-id', 'authored-query-id',
    ];
    // Each one, changed alone, must change the hash — i.e. it still participates.
    for (const marker of CONTENT_IDS) {
      const a = synthetic();
      const b = JSON.parse(JSON.stringify(a));
      const swap = (o) => {
        if (Array.isArray(o)) return o.forEach(swap);
        if (!o || typeof o !== 'object') return;
        if (o.id === marker) o.id = `${marker}-CHANGED`;
        Object.values(o).forEach(swap);
      };
      swap(b);
      assert.notEqual(contentHash(a), contentHash(b),
        `an authored id at ${marker} must participate in the comparison`);
    }
  })

  test('PROOF — losing a whole path variable is still detected', () => {
    const l = local();
    const r = JSON.parse(JSON.stringify(l));
    const it = requests(r).find((x) => x.request?.url?.variable?.length);
    it.request.url.variable = [];
    assert.notEqual(contentHash(l), contentHash(r));
    assert.ok(safeDiff(l, r).added.length + safeDiff(l, r).changed.length > 0);
  })
})

describe('R5 CLASS 3 — raw is DERIVED from the structured URL, not ignored', () => {
  test('the derivation excludes disabled params, and includes them on request', () => {
    const url = {
      host: ['{{base_url}}'],
      path: ['api', 'watchlist'],
      query: [{ key: 'page', value: '', disabled: true }, { key: 'q', value: '1' }],
    };
    assert.equal(canonicalRawUrl(url), '{{base_url}}/api/watchlist?q=1');
    assert.equal(canonicalRawUrl(url, { includeDisabled: true }),
      '{{base_url}}/api/watchlist?page=&q=1');
  })

  test('it returns null when the structure is NOT authoritative, so raw keeps comparing', () => {
    assert.equal(canonicalRawUrl({ raw: 'https://x.test/a' }), null);
    assert.equal(canonicalRawUrl({ host: ['x'], raw: 'x' }), null, 'path is required too');
    assert.equal(canonicalRawUrl('a string'), null);
    // and a url with no derivable structure still reports a raw difference
    const l = local();
    const r = JSON.parse(JSON.stringify(l));
    const a = requests(l)[0];
    const b = requests(r)[0];
    a.request.url = { raw: '{{base_url}}/api/one' };
    b.request.url = { raw: '{{base_url}}/api/two' };
    assert.notEqual(contentHash(l), contentHash(r));
  })

  test('PROOF — a genuine PATH change still fails comparison', () => {
    const l = local();
    const r = JSON.parse(JSON.stringify(l));
    const it = requests(r).find((x) => x.request?.url?.path?.join('/') === 'api/labels'
      && x.request.method === 'GET');
    it.request.url.path = ['api', 'label'];
    it.request.url.raw = '{{base_url}}/api/label?page=&limit=&search=';
    assert.notEqual(contentHash(l), contentHash(r));
    /*
     * Reported as added + removed rather than as a `changed` url path, because a request is
     * SELECTED by method and normalized path — so changing the path changes the request's
     * identity: one operation disappears and another appears. That is the more honest report,
     * and an earlier version of this test asserted the wrong shape rather than the wrong result.
     */
    const d = safeDiff(l, r);
    assert.ok(d.added.some((p) => /api\/labels/.test(p)), 'the old path must be reported missing');
    assert.ok(d.removed.some((p) => /api\/label\b/.test(p)), 'the new path must be reported extra');
  })

  test('PROOF — a genuine HOST change still fails comparison', () => {
    const l = local();
    const r = JSON.parse(JSON.stringify(l));
    requests(r)[0].request.url.host = ['https://evil.test'];
    assert.notEqual(contentHash(l), contentHash(r));
  })

  test('every query parameter in the published artifact is currently DISABLED', () => {
    /*
     * Recorded as a fact, because it bounds what the derivation can hide today: with no enabled
     * parameter anywhere, every derived `raw` is a bare path and the query string contributes
     * nothing to the comparison. The next test proves that an enabled parameter is still
     * compared, so this is a property of today's artifact rather than a gap in the rule.
     */
    const enabled = requests(local())
      .flatMap((i) => (i.request?.url?.query ?? []).filter((q) => q.disabled !== true));
    assert.equal(enabled.length, 0);
  })

  test('PROOF — changing an ENABLED query value still fails comparison', () => {
    // Constructed on BOTH sides, since the artifact has none to mutate.
    const withEnabled = () => {
      const doc = local();
      const it = requests(doc).find((x) => x.request?.url?.query?.length);
      it.request.url.query.push({ key: 'live', value: 'one' });
      it.request.url.raw = canonicalRawUrl(it.request.url, { includeDisabled: true });
      return doc;
    };
    const l = withEnabled();
    const r = withEnabled();
    const it = requests(r).find((x) => (x.request?.url?.query ?? []).some((q) => q.key === 'live'));
    it.request.url.query.find((q) => q.key === 'live').value = 'tampered';
    it.request.url.raw = canonicalRawUrl(it.request.url, { includeDisabled: true });
    assert.notEqual(contentHash(l), contentHash(r), 'an enabled query value must be compared');
    assert.ok(safeDiff(l, r).changed.some((p) => /query/.test(p) || /raw/.test(p)));
  })

  test('PROOF — ADDING a query parameter still fails comparison', () => {
    const l = local();
    const r = JSON.parse(JSON.stringify(l));
    requests(r)[0].request.url.query = [{ key: 'injected', value: '1' }];
    assert.notEqual(contentHash(l), contentHash(r));
  })

  test('PROOF — merely ENABLING a disabled parameter changes the comparison', () => {
    // This is the one case derivation must NOT swallow: a disabled param becoming live is a real
    // behavioural change to the published request.
    const l = local();
    const r = JSON.parse(JSON.stringify(l));
    const it = requests(r).find((x) => (x.request?.url?.query ?? []).some((q) => q.disabled === true));
    it.request.url.query.find((q) => q.disabled === true).disabled = false;
    assert.notEqual(contentHash(l), contentHash(r));
  })

  test('the ARTIFACT may not contradict itself, and today does not', () => {
    assert.deepEqual(rawUrlConsistencyProblems(local()), []);
    // a raw that disagrees with its own structure is a problem, reported with its path
    const r = local();
    requests(r)[0].request.url.raw = '{{base_url}}/api/something-else';
    const problems = rawUrlConsistencyProblems(r);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /contradicts host\/path\/query/);
  })
})

describe('R5 CLASS 1 — the collection-level variable array', () => {
  test('local declares an EMPTY array; empty and absent compare equal', () => {
    assert.deepEqual(local().variable, []);
    const r = local();
    delete r.variable;
    assert.equal(contentHash(local()), contentHash(r));
  })

  test('PROOF — a NON-empty remote variable array is real drift and is still reported', () => {
    const l = local();
    const r = local();
    r.variable = [{ key: 'injected_by_someone', value: 'x' }];
    assert.notEqual(contentHash(l), contentHash(r));
    // and it is named precisely, not as a coarse `variable`
    assert.deepEqual(safeDiff(l, r).removed, ['variable[injected_by_someone]']);
  })

  test('a request-level url.variable is NOT touched by the collection-root rule', () => {
    // The two arrays share a field name and must not share a rule.
    const l = local();
    const r = JSON.parse(JSON.stringify(l));
    const it = requests(r).find((x) => x.request?.url?.variable?.length);
    it.request.url.variable.push({ key: 'extra', value: 'x' });
    assert.notEqual(contentHash(l), contentHash(r));
  })
})
