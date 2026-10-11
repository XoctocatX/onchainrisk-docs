/**
 * R4 — server-generated structural metadata.
 *
 * A current GET returns `createdAt` / `updatedAt` on folders, requests and response examples as
 * well as on the collection. Neither checked-in collection carries them structurally, so before
 * this every ordinary GET differed from the canonical file purely by server timestamps: a false
 * ACTION=UPDATE, and then a post-PUT verification that could never match because the verifying
 * GET added them again.
 *
 * The fixture below is modelled on the current official GET shape and is meant to act as the
 * regression gate against future omissions. It contains no credentials and no account-specific
 * values — the owner id is a placeholder.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECTIONS, MANAGED_FIELDS,
  normalizeForCompare, contentHash, semanticallyEqual,
  buildIdentityMap, injectRemoteIds, readLocal,
} from '../postman-sync.mjs';

const OWNER = '00000000';
const CID = 'aaaaaaaa-1111-2222-3333-444444444444';
const CREATED = '2026-01-15T08:00:00.000Z';
const UPDATED = '2026-10-11T12:34:56.000Z';

/**
 * A collection as the current GET /collections/{id} returns it: identity AND server timestamps
 * at the collection, folder, request and response-example levels, plus nested and root events.
 */
function officialGetShape({ created = CREATED, updated = UPDATED, seed = 0 } = {}) {
  const n = (i) => `${seed}${i}`;
  return {
    collection: {
      info: {
        _postman_id: CID,
        name: 'Fixture Collection',
        description: 'collection-level prose',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        updatedAt: updated,
        createdAt: created,
        lastUpdatedBy: OWNER,
        uid: `${OWNER}-${CID}`,
        owner: OWNER,
        fork: null,
        lastRevision: 12345,
      },
      event: [
        { listen: 'prerequest', id: `root-e-${n(1)}`, script: { id: `root-s-${n(1)}`, type: 'text/javascript', exec: ['pm.collectionVariables.set("t", 1)'] } },
        { listen: 'test', id: `root-e-${n(2)}`, script: { id: `root-s-${n(2)}`, type: 'text/javascript', exec: ['pm.test("envelope", () => {})'] } },
      ],
      item: [
        {
          name: 'Folder One',
          description: 'folder prose',
          id: `f-${n(3)}`,
          uid: `${OWNER}-f-${n(3)}`,
          createdAt: created,
          updatedAt: updated,
          item: [
            {
              name: 'GET thing',
              id: `r-${n(4)}`,
              uid: `${OWNER}-r-${n(4)}`,
              createdAt: created,
              updatedAt: updated,
              request: {
                method: 'GET',
                url: { raw: '{{base_url}}/api/v1/thing' },
                header: [{ key: 'Authorization', value: 'Bearer {{key}}' }],
                description: 'request prose',
              },
              event: [
                { listen: 'test', id: `e-${n(5)}`, script: { id: `s-${n(5)}`, type: 'text/javascript', exec: ['pm.test("ok", () => {})'] } },
              ],
              response: [
                {
                  name: '200 ok',
                  id: `x-${n(6)}`,
                  uid: `${OWNER}-x-${n(6)}`,
                  createdAt: created,
                  updatedAt: updated,
                  code: 200,
                  status: 'OK',
                  // the body is OUR content and deliberately contains timestamp-named fields
                  body: '{"reportId":"abc","createdAt":"2026-05-01T00:00:00Z","updatedAt":"2026-05-02T00:00:00Z"}',
                },
              ],
            },
          ],
        },
      ],
      variable: [{ key: 'base_url', value: 'https://api.example.test' }],
    },
  };
}

/** The same collection as checked in: identical content, no managed field anywhere. */
function canonicalLocal() {
  const c = JSON.parse(JSON.stringify(officialGetShape().collection));
  for (const k of [...MANAGED_FIELDS.MANAGED.collectionInfo]) delete c.info[k];
  for (const k of MANAGED_FIELDS.MANAGED.collectionTop) delete c[k];
  for (const e of c.event) { delete e.id; delete e.script.id; }
  const walk = (nodes) => {
    for (const x of nodes ?? []) {
      for (const k of MANAGED_FIELDS.MANAGED.item) delete x[k];
      for (const r of x.response ?? []) for (const k of MANAGED_FIELDS.MANAGED.response) delete r[k];
      for (const e of x.event ?? []) { delete e.id; if (e.script) delete e.script.id; }
      if (x.item) walk(x.item);
    }
  };
  walk(c.item);
  return c;
}

describe('the managed-field model separates identity from server metadata', () => {
  const { IDENTITY, SERVER_METADATA, MANAGED } = MANAGED_FIELDS;

  test('nested timestamps are modelled as server metadata at item and response level', () => {
    assert.deepEqual(SERVER_METADATA.item, ['createdAt', 'updatedAt']);
    assert.deepEqual(SERVER_METADATA.response, ['createdAt', 'updatedAt']);
    assert.equal(MANAGED.item.includes('createdAt'), true);
    assert.equal(MANAGED.response.includes('updatedAt'), true);
  });

  test('server metadata is NOT part of identity, so it is never echoed back', () => {
    for (const kind of ['item', 'response', 'collectionInfo']) {
      for (const k of SERVER_METADATA[kind] ?? []) {
        assert.equal((IDENTITY[kind] ?? []).includes(k), false, `${kind}.${k} must not be identity`);
      }
    }
  });

  test('timestamps are not modelled where the API does not return them', () => {
    for (const kind of ['event', 'eventScript']) {
      assert.equal((MANAGED[kind] ?? []).includes('createdAt'), false, `${kind} must not strip createdAt`);
      assert.equal((MANAGED[kind] ?? []).includes('updatedAt'), false);
    }
  });
});

describe('ITEM_SERVER_TIMESTAMPS_NOOP / RESPONSE_SERVER_TIMESTAMPS_NOOP', () => {
  test('a remote differing only by item timestamps is a semantic NOOP', () => {
    const local = canonicalLocal();
    const remote = { collection: JSON.parse(JSON.stringify(local)) };
    remote.collection.item[0].createdAt = CREATED;
    remote.collection.item[0].updatedAt = UPDATED;
    remote.collection.item[0].item[0].createdAt = CREATED;
    remote.collection.item[0].item[0].updatedAt = UPDATED;
    assert.equal(semanticallyEqual(local, remote), true);
  });

  test('a remote differing only by response-example timestamps is a semantic NOOP', () => {
    const local = canonicalLocal();
    const remote = { collection: JSON.parse(JSON.stringify(local)) };
    const r = remote.collection.item[0].item[0].response[0];
    r.createdAt = CREATED;
    r.updatedAt = UPDATED;
    assert.equal(semanticallyEqual(local, remote), true);
  });

  test('normalization clears them at both positions', () => {
    const n = normalizeForCompare(officialGetShape());
    const folder = n.item[0];
    const req = folder.item[0];
    for (const [label, holder] of [['folder', folder], ['request', req], ['response', req.response[0]]]) {
      assert.equal(holder.createdAt, undefined, `${label}.createdAt`);
      assert.equal(holder.updatedAt, undefined, `${label}.updatedAt`);
    }
    assert.equal(n.info.createdAt, undefined);
    assert.equal(n.info.lastRevision, undefined);
  });
});

describe('OFFICIAL_GET_SHAPE_MANAGED_ONLY_DIFF_IS_NOOP', () => {
  test('the full official-shaped remote equals the canonical local file', () => {
    assert.equal(semanticallyEqual(canonicalLocal(), officialGetShape()), true);
  });

  test('every content field survives normalization', () => {
    const n = normalizeForCompare(officialGetShape());
    assert.equal(n.info.name, 'Fixture Collection');
    assert.equal(n.info.description, 'collection-level prose');
    assert.equal(n.item[0].description, 'folder prose');
    assert.equal(n.item[0].item[0].request.description, 'request prose');
    assert.equal(n.item[0].item[0].request.header[0].key, 'Authorization');
    assert.equal(n.item[0].item[0].response[0].code, 200);
    assert.equal(n.item[0].item[0].response[0].status, 'OK');
    assert.deepEqual(n.variable, [{ key: 'base_url', value: 'https://api.example.test' }]);
    assert.deepEqual(n.event[1].script.exec, ['pm.test("envelope", () => {})']);
  });

  test('real content drift in the official shape is still detected', () => {
    for (const mutate of [
      (c) => { c.collection.info.description = 'edited remotely'; },
      (c) => { c.collection.item[0].description = 'edited remotely'; },
      (c) => { c.collection.item[0].item[0].request.url.raw = '{{base_url}}/api/v1/other'; },
      (c) => { c.collection.item[0].item[0].request.header[0].value = 'Bearer leaked'; },
      (c) => { c.collection.item[0].item[0].response[0].status = 'Created'; },
      (c) => { c.collection.variable[0].value = 'https://elsewhere.test'; },
      (c) => { c.collection.event[0].script.exec = ['tampered()']; },
    ]) {
      const remote = officialGetShape();
      mutate(remote);
      assert.equal(semanticallyEqual(canonicalLocal(), remote), false);
    }
  });

  test('all identities are preserved and no timestamp is echoed back', () => {
    const remote = officialGetShape();
    const out = injectRemoteIds(canonicalLocal(), buildIdentityMap(remote), {
      remoteInfoIdentity: { _postman_id: CID, uid: `${OWNER}-${CID}` },
    });
    const s = JSON.stringify(out);
    assert.equal(out.item[0].id, remote.collection.item[0].id);
    assert.equal(out.item[0].uid, remote.collection.item[0].uid);
    assert.equal(out.item[0].item[0].response[0].id, remote.collection.item[0].item[0].response[0].id);
    assert.equal(out.event[0].script.id, remote.collection.event[0].script.id);
    // server metadata must NOT be sent back
    assert.equal('createdAt' in out.item[0], false, 'item createdAt must not be echoed');
    assert.equal('updatedAt' in out.item[0], false);
    assert.equal('createdAt' in out.item[0].item[0].response[0], false, 'response createdAt must not be echoed');
    assert.equal('lastRevision' in out.info, false);
    assert.equal('owner' in out.info, false);
    assert.equal(s.includes(UPDATED), false, 'no server timestamp value anywhere in the payload');
    // and the content timestamps inside the example body DO survive
    assert.match(out.item[0].item[0].response[0].body, /"createdAt":"2026-05-01T00:00:00Z"/);
  });
});

describe('POST_PUT_FRESH_TIMESTAMPS_VERIFY', () => {
  test('an after-PUT GET with fresh timestamps and fresh ids still verifies equal', () => {
    const local = canonicalLocal();
    const after = officialGetShape({ created: '2026-10-11T12:00:00.000Z', updated: '2026-10-11T13:00:00.000Z', seed: 9 });
    assert.notEqual(JSON.stringify(after.collection), JSON.stringify(officialGetShape().collection), 'fixture must actually differ');
    assert.equal(contentHash(local), contentHash(after), 'verification must tolerate regenerated metadata');
  });

  test('but a content change in the after-PUT GET fails verification', () => {
    const local = canonicalLocal();
    const after = officialGetShape({ updated: '2026-10-11T13:00:00.000Z', seed: 9 });
    after.collection.item[0].item[0].request.description = 'server kept something of its own';
    assert.notEqual(contentHash(local), contentHash(after));
  });
});

describe('CONTENT_TIMESTAMP_FIELDS_PRESERVED / TIMESTAMP_NORMALIZATION_POSITION_AWARE', () => {
  test('timestamp-named fields inside authoritative content stay in the hash', () => {
    const local = canonicalLocal();
    const remote = officialGetShape();
    assert.equal(semanticallyEqual(local, remote), true, 'baseline');
    // change the timestamp strings INSIDE the response-example body
    remote.collection.item[0].item[0].response[0].body =
      '{"reportId":"abc","createdAt":"1999-01-01T00:00:00Z","updatedAt":"2026-05-02T00:00:00Z"}';
    assert.equal(semanticallyEqual(local, remote), false, 'content timestamp drift must be detected');
  });

  test('a non-managed content object with createdAt/updatedAt survives normalization', () => {
    const remote = officialGetShape();
    remote.collection.variable.push({ key: 'audit', value: JSON.stringify({ createdAt: 'business-data', updatedAt: 'business-data' }) });
    remote.collection.item[0].item[0].request.body = { mode: 'raw', raw: '{"createdAt":"business-data","updatedAt":"business-data"}' };
    const n = normalizeForCompare(remote);
    assert.match(n.variable[1].value, /business-data/);
    assert.match(n.item[0].item[0].request.body.raw, /"createdAt":"business-data"/);
    assert.match(n.item[0].item[0].request.body.raw, /"updatedAt":"business-data"/);
  });

  test('no recursive delete-by-name: a request-level createdAt is content, not metadata', () => {
    // `request` is not a managed position, so a timestamp-named key there is ours.
    const remote = officialGetShape();
    remote.collection.item[0].item[0].request.createdAt = 'content-value';
    const n = normalizeForCompare(remote);
    assert.equal(n.item[0].item[0].request.createdAt, 'content-value');
    const drifted = officialGetShape();
    drifted.collection.item[0].item[0].request.createdAt = 'changed';
    assert.equal(semanticallyEqual(remote, drifted), false);
  });

  test('the four createdAt strings in the REAL paid collection are content and survive', () => {
    const local = readLocal('paid-collection.json');
    const raw = JSON.stringify(local);
    const before = (raw.match(/createdAt/g) ?? []).length;
    assert.equal(before, 4, 'the real collection carries four content-level createdAt strings');
    const normalized = JSON.stringify(normalizeForCompare(local));
    assert.equal((normalized.match(/createdAt/g) ?? []).length, 4, 'all four must survive normalization');
  });
});

describe('the real collections stay deterministic', () => {
  for (const entry of COLLECTIONS) {
    test(`${entry.file} is a NOOP against a server-shaped remote of itself`, () => {
      const local = readLocal(entry.file);
      const remote = { collection: JSON.parse(JSON.stringify(local)) };
      remote.collection.info._postman_id = 'cloud-id';
      remote.collection.info.uid = `${OWNER}-cloud-id`;
      remote.collection.info.createdAt = CREATED;
      remote.collection.info.updatedAt = UPDATED;
      remote.collection.info.lastRevision = 999;
      let i = 0;
      const walk = (nodes) => {
        for (const x of nodes ?? []) {
          x.id = `i-${i++}`; x.uid = `${OWNER}-i-${i++}`;
          x.createdAt = CREATED; x.updatedAt = UPDATED;
          for (const r of x.response ?? []) { r.id = `x-${i++}`; r.uid = `${OWNER}-x-${i++}`; r.createdAt = CREATED; r.updatedAt = UPDATED; }
          for (const e of x.event ?? []) { e.id = `e-${i++}`; if (e.script) e.script.id = `s-${i++}`; }
          if (x.item) walk(x.item);
        }
      };
      walk(remote.collection.item);
      assert.equal(semanticallyEqual(local, remote), true, 'an ordinary GET must not look like drift');
      const out = injectRemoteIds(local, buildIdentityMap(remote), {});
      assert.equal(contentHash(out), contentHash(local));
      assert.equal(JSON.stringify(out).includes(UPDATED), false, 'no server timestamp may be echoed');
      assert.equal(JSON.stringify(out).includes('"i-0"'), true, 'ids must be preserved');
    });

    test(`${entry.file} hashes identically twice`, () => {
      assert.equal(contentHash(readLocal(entry.file)), contentHash(readLocal(entry.file)));
    });
  }
});
