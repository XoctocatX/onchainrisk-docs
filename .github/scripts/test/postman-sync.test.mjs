/**
 * Unit tests for the Postman publisher. Local fixtures and the two real checked-in collections
 * only — no network, no API key, nothing mutated. Run: node --test .github/scripts/test/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeForCompare, contentHash, semanticallyEqual, normalizePath,
  buildIdentityMap, injectRemoteIds, folderKey, requestKey,
  redact, fingerprint, readLocal, COLLECTIONS, SyncError, environmentContentHash
} from '../postman-sync.mjs';

/** Minimal collection in the real shape, with Postman-managed IDs present. */
const remoteish = () => ({
  collection: {
    info: { name: 'C', _postman_id: 'cloud-abc', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', updatedAt: '2026-01-01T00:00:00Z', description: 'remote prose' },
    item: [
      {
        name: 'Folder A', id: 'f-1',
        item: [
          { name: 'GET thing', id: 'r-1', request: { method: 'GET', url: { raw: '{{base_url}}/api/v1/thing' }, headers: [{ key: 'Authorization', value: 'Bearer {{k}}' }] },
            response: [{ name: '200 ok', id: 'ex-1', code: 200, body: '{}' }] },
          { name: 'POST thing', id: 'r-2', request: { method: 'POST', url: { raw: '{{base_url}}/api/v1/thing' } } },
        ],
      },
    ],
  },
});

/** The same collection as it is checked in: our content, no Postman IDs. */
const localish = () => ({
  info: { name: 'C', _postman_id: 'local-doc-id', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'local prose' },
  item: [
    {
      name: 'Folder A',
      item: [
        { name: 'GET thing', request: { method: 'GET', url: { raw: '{{base_url}}/api/v1/thing' }, headers: [{ key: 'Authorization', value: 'Bearer {{k}}' }] },
          response: [{ name: '200 ok', code: 200, body: '{}' }] },
        { name: 'POST thing', request: { method: 'POST', url: { raw: '{{base_url}}/api/v1/thing' } } },
      ],
    },
  ],
});

describe('1 — semantic equality ignores Postman-managed IDs, and only those', () => {
  test('a remote carrying IDs equals a local that has none, when content matches', () => {
    const local = localish();
    const remote = remoteish();
    // make the one genuinely-content field equal; the rest differs only by managed IDs
    remote.collection.info.description = 'local prose';
    assert.equal(semanticallyEqual(local, remote), true);
  });

  test('normalization removes exactly the documented managed keys', () => {
    const n = normalizeForCompare(remoteish());
    assert.equal(n.info._postman_id, undefined);
    assert.equal(n.info.updatedAt, undefined);
    assert.equal(n.item[0].id, undefined);
    assert.equal(n.item[0].item[0].id, undefined);
    assert.equal(n.item[0].item[0].response[0].id, undefined);
    // and keeps everything that is ours
    assert.equal(n.info.name, 'C');
    assert.equal(n.info.schema.includes('schema.getpostman.com'), true);
    assert.equal(n.item[0].item[0].request.headers[0].key, 'Authorization');
    assert.equal(n.item[0].item[0].response[0].body, '{}');
  });
});

describe('2 — meaningful remote drift is NOT normalized away', () => {
  const cases = [
    ['description', (c) => { c.collection.item[0].item[0].request.description = 'someone edited this in the Postman UI'; }],
    ['url', (c) => { c.collection.item[0].item[0].request.url.raw = '{{base_url}}/api/v1/other'; }],
    ['method', (c) => { c.collection.item[0].item[0].request.method = 'PATCH'; }],
    ['header', (c) => { c.collection.item[0].item[0].request.headers.push({ key: 'X-Extra', value: '1' }); }],
    ['auth', (c) => { c.collection.item[0].item[0].request.auth = { type: 'noauth' }; }],
    ['event script', (c) => { c.collection.item[0].item[0].event = [{ listen: 'test', script: { exec: ['pm.test(1)'] } }]; }],
    ['variable', (c) => { c.collection.variable = [{ key: 'injected', value: 'x' }]; }],
    ['example body', (c) => { c.collection.item[0].item[0].response[0].body = '{"changed":true}'; }],
    ['example status', (c) => { c.collection.item[0].item[0].response[0].code = 418; }],
    ['folder name', (c) => { c.collection.item[0].name = 'Folder Renamed'; }],
    ['collection description', (c) => { c.collection.info.description = 'remote edit'; }],
  ];
  for (const [what, mutate] of cases) {
    test(`remote ${what} drift is detected`, () => {
      const local = localish();
      const remote = remoteish();
      remote.collection.info.description = 'local prose';
      assert.equal(semanticallyEqual(local, remote), true, 'baseline must match');
      mutate(remote);
      assert.equal(semanticallyEqual(local, remote), false, `${what} must not normalize away`);
    });
  }
});

describe('3 — a matching request keeps its remote ID in the outbound payload', () => {
  test('ids are injected for folder, request and response example', () => {
    const map = buildIdentityMap(remoteish());
    const out = injectRemoteIds(localish(), map, { remoteInfoIdentity: { _postman_id: 'cloud-abc' } });
    assert.equal(out.item[0].id, 'f-1');
    assert.equal(out.item[0].item[0].id, 'r-1');
    assert.equal(out.item[0].item[1].id, 'r-2');
    assert.equal(out.item[0].item[0].response[0].id, 'ex-1');
  });

  test('the API payload addresses the cloud collection, but content stays local', () => {
    const out = injectRemoteIds(localish(), buildIdentityMap(remoteish()), { remoteInfoIdentity: { _postman_id: 'cloud-abc' } });
    assert.equal(out.info._postman_id, 'cloud-abc');
    assert.equal(out.info.description, 'local prose');
  });

  test('the checked-in file is not mutated by building a payload', () => {
    const local = localish();
    const before = JSON.stringify(local);
    injectRemoteIds(local, buildIdentityMap(remoteish()), { remoteInfoIdentity: { _postman_id: 'cloud-abc' } });
    assert.equal(JSON.stringify(local), before);
  });
});

describe('4 — a new local request receives no fabricated ID', () => {
  test('an item with no remote counterpart carries no id', () => {
    const local = localish();
    local.item[0].item.push({ name: 'DELETE thing', request: { method: 'DELETE', url: { raw: '{{base_url}}/api/v1/thing' } } });
    const out = injectRemoteIds(local, buildIdentityMap(remoteish()), { remoteInfoIdentity: { _postman_id: 'cloud-abc' } });
    const added = out.item[0].item.find((x) => x.name === 'DELETE thing');
    assert.equal('id' in added, false);
    assert.equal('_postman_id' in added, false);
  });

  test('a stale local id is dropped rather than sent as if Postman knew it', () => {
    const local = localish();
    local.item[0].item.push({ name: 'NEW', id: 'invented-locally', request: { method: 'PUT', url: { raw: '{{base_url}}/api/v1/new' } } });
    const out = injectRemoteIds(local, buildIdentityMap(remoteish()), {});
    const added = out.item[0].item.find((x) => x.name === 'NEW');
    assert.equal('id' in added, false);
    assert.equal(JSON.stringify(out).includes('invented-locally'), false);
  });
});

describe('5 — a request removed locally stays removed', () => {
  test('the outbound payload contains only local items', () => {
    const local = localish();
    local.item[0].item = local.item[0].item.filter((x) => x.name !== 'POST thing');
    const out = injectRemoteIds(local, buildIdentityMap(remoteish()), {});
    const names = out.item[0].item.map((x) => x.name);
    assert.deepEqual(names, ['GET thing']);
    assert.equal(JSON.stringify(out).includes('r-2'), false);
  });
});

describe('6 — duplicate stable request identity fails closed', () => {
  test('two requests with the same ancestry, method and path abort', () => {
    const local = localish();
    local.item[0].item.push({ name: 'GET thing (copy)', request: { method: 'GET', url: { raw: '{{base_url}}/api/v1/thing' } } });
    assert.throws(() => buildIdentityMap(local, { label: 'local' }), (e) => e instanceof SyncError && /ambiguous identity/.test(e.message));
  });

  test('a differing query string does NOT make two requests distinct', () => {
    const local = localish();
    local.item[0].item.push({ name: 'GET thing filtered', request: { method: 'GET', url: { raw: '{{base_url}}/api/v1/thing?limit=5' } } });
    assert.throws(() => buildIdentityMap(local), /ambiguous identity/);
  });
});

describe('7 — ambiguous folder identity fails closed', () => {
  test('two folders with the same full ancestry abort', () => {
    const local = localish();
    local.item.push({ name: 'Folder A', item: [] });
    assert.throws(() => buildIdentityMap(local), (e) => e instanceof SyncError && /ambiguous identity folder:Folder A/.test(e.message));
  });

  test('the same folder name under different parents is NOT ambiguous', () => {
    const local = localish();
    local.item.push({ name: 'Folder B', item: [{ name: 'Folder A', item: [] }] });
    assert.doesNotThrow(() => buildIdentityMap(local));
  });

  test('an ambiguous response-example name preserves no example ID', () => {
    const remote = remoteish();
    remote.collection.item[0].item[0].response.push({ name: '200 ok', id: 'ex-2', code: 200, body: '{}' });
    const map = buildIdentityMap(remote);
    assert.equal(map.get(requestKey(['Folder A'], 'GET', { raw: '{{base_url}}/api/v1/thing' })).responses.has('200 ok'), false);
  });
});

describe('8 — remote content can never overwrite local content', () => {
  test('remote descriptions, scripts, variables and auth are not copied back', () => {
    const remote = remoteish();
    remote.collection.info.description = 'REMOTE EDITED PROSE';
    remote.collection.variable = [{ key: 'remote_only', value: 'leaked' }];
    remote.collection.item[0].item[0].request.description = 'remote request prose';
    remote.collection.item[0].item[0].event = [{ listen: 'test', script: { exec: ['remote()'] } }];
    remote.collection.item[0].item[0].request.auth = { type: 'basic' };
    const out = injectRemoteIds(localish(), buildIdentityMap(remote), { remoteInfoIdentity: { _postman_id: 'cloud-abc' } });
    const s = JSON.stringify(out);
    assert.equal(out.info.description, 'local prose');
    assert.equal(s.includes('REMOTE EDITED PROSE'), false);
    assert.equal(s.includes('remote_only'), false);
    assert.equal(s.includes('remote request prose'), false);
    assert.equal(s.includes('remote()'), false);
    assert.equal(s.includes('basic'), false);
    // ids, and only ids, crossed over
    assert.equal(out.item[0].item[0].id, 'r-1');
  });
});

describe('9 — post-PUT semantic mismatch fails', () => {
  test('a verification comparison is by content hash, so any content delta fails', () => {
    const local = localish();
    const after = remoteish();
    after.collection.info.description = 'local prose';
    assert.equal(contentHash(local), contentHash(after), 'identical content must verify');
    after.collection.item[0].item[0].request.url.raw = '{{base_url}}/api/v1/tampered';
    assert.notEqual(contentHash(local), contentHash(after));
  });
});

describe('10 — secrets never reach logs or errors', () => {
  const KEY = 'PMAK-DUMMY-not-a-real-key-for-redaction-tests';
  test('redact removes every occurrence', () => {
    const msg = redact(`PUT failed for key ${KEY} and again ${KEY}`, KEY);
    assert.equal(msg.includes(KEY), false);
    assert.equal(msg.includes('***redacted***'), true);
  });
  test('redact is a no-op when no secret is configured', () => {
    assert.equal(redact('plain text', undefined), 'plain text');
  });
  test('fingerprint never reveals the whole value', () => {
    const f = fingerprint('abcdefghijklmnop');
    assert.equal(f.includes('abcdefghijkl'), false);
    assert.match(f, /len=16 sha256:[0-9a-f]{8} …mnop/);
  });
  test('fingerprint of an unset value is explicit', () => {
    assert.equal(fingerprint(undefined), '(unset)');
  });
  test('the script source contains no literal key and never prints env', () => {
    const src = readFileSync(new URL('../postman-sync.mjs', import.meta.url), 'utf8');
    assert.equal(/PMAK-[A-Za-z0-9]/.test(src), false);
    assert.equal(src.includes('console.log(process.env'), false);
    assert.equal(/set -x/.test(src), false);
  });
});

describe('the repository passes the checks the workflow runs', () => {
  const SECRET_SHAPED = /PMAK-[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{20,}|ocr_(live|test|sandbox)_[A-Za-z0-9]{12,}/;
  const files = [
    'onchainrisk_api_collection.json', 'onchainrisk_api_collection.json',
    'production.postman_environment.json', 'sandbox.postman_environment.json',
    'README.md', '.github/workflows/publish-postman.yml',
    '.github/scripts/postman-sync.mjs', '.github/scripts/test/postman-sync.test.mjs',
  ];
  for (const f of files) {
    test(`${f} carries no secret-shaped material`, () => {
      const t = readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');
      const hit = t.match(SECRET_SHAPED);
      assert.equal(hit, null, hit ? `matched ${hit[0].slice(0, 12)}…` : '');
    });
  }

  test('the workflow declares no pull_request_target TRIGGER', () => {
    // Anchored to a trigger key, not raw text: the workflow's own comments explain why that
    // trigger is avoided, and a substring check would flag the explanation itself.
    const wf = readFileSync(new URL('../../workflows/publish-postman.yml', import.meta.url), 'utf8');
    assert.equal(/^\s{0,4}pull_request_target\s*:/m.test(wf), false);
    const triggers = [...wf.matchAll(/^  ([a-z_]+):$/gm)].map((m) => m[1]);
    assert.deepEqual(triggers.filter((t) => t.startsWith('pull_request')), ['pull_request']);
  });

  test('the workflow asks for no more than contents: read', () => {
    const wf = readFileSync(new URL('../../workflows/publish-postman.yml', import.meta.url), 'utf8');
    assert.match(wf, /permissions:\n  contents: read\n/);
    assert.equal(/permissions:[\s\S]*?\bwrite\b/.test(wf.split('jobs:')[0]), false);
  });

  test('publication is gated on main and never on a pull request', () => {
    const wf = readFileSync(new URL('../../workflows/publish-postman.yml', import.meta.url), 'utf8');
    const publish = wf.slice(wf.indexOf('  publish:'), wf.indexOf('  verify-only:'));
    assert.match(publish, /github\.ref == 'refs\/heads\/main'/);
    assert.equal(publish.includes('pull_request'), false);
  });

  test('publication is narrowed to the three published artifact files', () => {
    // Was "the two collection files". The published set is one collection and two environments
    // now, and the narrowing property is unchanged: editing the README, the changelog, an
    // integration guide or this workflow must NOT republish anything.
    const wf = readFileSync(new URL('../../workflows/publish-postman.yml', import.meta.url), 'utf8');
    const push = wf.slice(wf.indexOf('  push:'), wf.indexOf('  workflow_dispatch:'));
    assert.match(push, /onchainrisk_api_collection\.json/);
    assert.match(push, /production\.postman_environment\.json/);
    assert.match(push, /sandbox\.postman_environment\.json/);
    assert.equal(push.includes('README'), false);
    assert.equal(push.includes('integration/'), false);
    assert.equal(push.includes('CHANGELOG'), false);
    // And the retired per-tier names must not linger as a filter that matches nothing.
    assert.equal(push.includes('paid-collection.json'), false);
    assert.equal(push.includes('onchainrisk_sandbox_api_collection.json'), false);
  });

  test('concurrency serializes publication and does not cancel mid-flight', () => {
    const wf = readFileSync(new URL('../../workflows/publish-postman.yml', import.meta.url), 'utf8');
    assert.match(wf, /group: postman-publish/);
    assert.match(wf, /cancel-in-progress: false/);
  });

  test('actions are pinned to an immutable commit, not a floating tag', () => {
    const wf = readFileSync(new URL('../../workflows/publish-postman.yml', import.meta.url), 'utf8');
    const uses = [...wf.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    assert.equal(uses.length > 0, true);
    for (const u of uses) {
      assert.match(u, /^actions\/[a-z-]+@[0-9a-f]{40}$/, `${u} must be an official action pinned to a 40-char SHA`);
    }
  });

  test('the script never calls POST /collections (no create fallback)', () => {
    const src = readFileSync(new URL('../postman-sync.mjs', import.meta.url), 'utf8');
    assert.equal(/'POST',\s*`?\/collections/.test(src), false);
    assert.equal(src.includes("postman('POST'"), false);
  });
});

describe('path normalization', () => {
  test('host, base-url variable and query are stripped; variables collapse', () => {
    assert.equal(normalizePath({ raw: '{{base_url}}/api/v1/check?network=eth' }), '/api/v1/check');
    assert.equal(normalizePath({ raw: 'https://api.onchainrisk.io/api/v1/usage' }), '/api/v1/usage');
    assert.equal(normalizePath({ raw: '{{base_url}}/api/labels/{{sample_label_id}}' }), '/api/labels/{var}');
    assert.equal(normalizePath('{{base_url}}/api/alerts/'), '/api/alerts');
  });
  test('two different path variables collapse to the same identity', () => {
    assert.equal(
      normalizePath({ raw: '{{base_url}}/api/labels/{{a}}' }),
      normalizePath({ raw: '{{base_url}}/api/labels/{{b}}' }),
    );
  });
});

describe('both real checked-in collections', () => {
  for (const entry of COLLECTIONS) {
    test(`${entry.file} parses, hashes and maps unambiguously`, () => {
      const local = readLocal(entry.file);
      assert.equal(typeof local.info.name, 'string');
      assert.match(contentHash(local), /^[0-9a-f]{64}$/);
      assert.doesNotThrow(() => buildIdentityMap(local, { label: entry.file }));
    });

    test(`${entry.file} round-trips through injectRemoteIds unchanged in content`, () => {
      const local = readLocal(entry.file);
      // a remote that is this very collection, with IDs assigned
      const withIds = JSON.parse(JSON.stringify(local));
      let n = 0;
      const assign = (nodes) => { for (const x of nodes ?? []) { x.id = `id-${n++}`; if (Array.isArray(x.item)) assign(x.item); for (const r of x.response ?? []) r.id = `ex-${n++}`; } };
      assign(withIds.item);
      const out = injectRemoteIds(local, buildIdentityMap(withIds), { remoteInfoIdentity: { _postman_id: 'cloud-x' } });
      assert.equal(contentHash(out), contentHash(local), 'injecting ids must not change content');
      assert.equal(semanticallyEqual(out, withIds), true);
    });

    test(`${entry.file} is stable: hashing twice gives the same digest`, () => {
      assert.equal(contentHash(readLocal(entry.file)), contentHash(readLocal(entry.file)));
    });
  }

  test('the paid collection keeps its two explicit noauth requests through a payload build', () => {
    const local = readLocal('onchainrisk_api_collection.json');
    const out = injectRemoteIds(local, new Map(), {});
    const noauth = [];
    const walk = (nodes) => { for (const x of nodes ?? []) { if (Array.isArray(x.item)) walk(x.item); else if (x.request?.auth?.type === 'noauth') noauth.push(x.name); } };
    walk(out.item);
    assert.equal(noauth.length, 2);
  });

  test('the two ENVIRONMENTS are not mistaken for each other', () => {
    // There were two collections to tell apart. There is one now — so the pair that CAN be
    // confused, and whose confusion would actually hurt, is the two environments: publishing the
    // production placeholder over the sandbox one hands a sandbox reader an `ocr_live_*`
    // placeholder. Their hashes must differ, and the difference must be the credential and the
    // tier, not an accident of ordering.
    const prod = readLocal('production.postman_environment.json');
    const sandbox = readLocal('sandbox.postman_environment.json');
    assert.notEqual(environmentContentHash(prod), environmentContentHash(sandbox));
    const valueOf = (doc, key) => doc.values.find((v) => v.key === key).value;
    assert.match(valueOf(prod, 'api_key'), /^ocr_live_/);
    assert.match(valueOf(sandbox, 'api_key'), /^ocr_test_/);
    assert.equal(valueOf(prod, 'tier'), 'production');
    assert.equal(valueOf(sandbox, 'tier'), 'sandbox');
    // …while the NAMES are identical, which is what lets one collection run on either.
    assert.deepEqual(prod.values.map((v) => v.key), sandbox.values.map((v) => v.key));
  });
});
