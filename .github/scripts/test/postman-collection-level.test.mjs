/**
 * R2 — collection-ROOT managed identity, the literal `postman_id` variant, and the tightened
 * target-identity rule.
 *
 * Collection v2.1 allows root-level events (collection-wide prerequest/test scripts) and the API
 * returns managed ids on them exactly as it does on an item's events. Missing those positions
 * would have produced false drift, script-id churn and a post-PUT mismatch the first time a
 * collection-wide script appeared.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECTIONS, COLLECTION_ROOT_KEY, SyncError,
  normalizeForCompare, contentHash, semanticallyEqual,
  buildIdentityMap, injectRemoteIds, identityConsistent, assertTargetBinding,
} from '../postman-sync.mjs';

const OWNER = '31415926';
const OTHER_OWNER = '27182818';
const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PAID = 'OnChainRisk API';

/** Server-shaped collection WITH root-level events carrying managed ids. */
function serverWithRootEvents({ name = PAID, id = ID } = {}) {
  return {
    collection: {
      info: {
        _postman_id: id,
        uid: `${OWNER}-${id}`,
        name,
        owner: OWNER,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        updatedAt: '2026-10-11T00:00:00.000Z',
      },
      event: [
        {
          listen: 'prerequest',
          id: 'ce000000-0000-0000-0000-00000000000a',
          script: { id: 'cs000000-0000-0000-0000-00000000000b', type: 'text/javascript', exec: ['pm.collectionVariables.set("t", Date.now())'] },
        },
        {
          listen: 'test',
          id: 'ce000000-0000-0000-0000-00000000000c',
          script: { id: 'cs000000-0000-0000-0000-00000000000d', type: 'text/javascript', exec: ['pm.test("envelope", () => pm.expect(pm.response.json()).to.have.property("success"))'] },
        },
      ],
      item: [
        {
          name: 'Analysis', id: 'f0000000-0000-0000-0000-00000000000e',
          item: [
            { name: 'POST check', id: 'r0000000-0000-0000-0000-00000000000f', uid: `${OWNER}-r0000000-0000-0000-0000-00000000000f`,
              request: { method: 'POST', url: { raw: '{{base_url}}/api/v1/check' } } },
          ],
        },
      ],
    },
  };
}

/** The same collection as checked in: identical content, no managed identity anywhere. */
function localWithRootEvents({ name = PAID } = {}) {
  const c = JSON.parse(JSON.stringify(serverWithRootEvents({ name }).collection));
  for (const k of ['_postman_id', 'uid', 'owner', 'updatedAt']) delete c.info[k];
  for (const e of c.event) { delete e.id; delete e.script.id; }
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      delete n.id; delete n.uid;
      if (n.item) walk(n.item);
    }
  };
  walk(c.item);
  return c;
}

describe('collection-level events are in the managed model', () => {
  test('TOP_LEVEL_MANAGED_ONLY_DIFF_IS_NOOP', () => {
    assert.equal(semanticallyEqual(localWithRootEvents(), serverWithRootEvents()), true);
  });

  test('root event and script ids are normalized out of the comparison', () => {
    const n = normalizeForCompare(serverWithRootEvents());
    assert.equal(n.event[0].id, undefined, 'collection.event[0].id');
    assert.equal(n.event[0].script.id, undefined, 'collection.event[0].script.id');
    assert.equal(n.event[1].id, undefined);
    assert.equal(n.event[1].script.id, undefined);
    // the script CONTENT stays, and stays comparable
    assert.deepEqual(n.event[1].script.exec, serverWithRootEvents().collection.event[1].script.exec);
    assert.equal(n.event[0].listen, 'prerequest');
  });

  test('TOP_LEVEL_EVENT_ID_PRESERVED and TOP_LEVEL_SCRIPT_ID_PRESERVED', () => {
    const remote = serverWithRootEvents();
    const out = injectRemoteIds(localWithRootEvents(), buildIdentityMap(remote), {});
    const byListen = (list, l) => list.find((e) => e.listen === l);
    for (const listen of ['prerequest', 'test']) {
      assert.equal(byListen(out.event, listen).id, byListen(remote.collection.event, listen).id, `${listen} event id`);
      assert.equal(byListen(out.event, listen).script.id, byListen(remote.collection.event, listen).script.id, `${listen} script id`);
    }
  });

  test('STALE_LOCAL_TOP_LEVEL_IDS_STRIPPED', () => {
    const local = localWithRootEvents();
    local.event[0].id = 'STALE-root-event';
    local.event[0].script.id = 'STALE-root-script';
    local.event[1].script.postman_id = 'STALE-root-postman-id';
    const out = injectRemoteIds(local, new Map(), {});     // nothing to match against
    const s = JSON.stringify(out);
    for (const stale of ['STALE-root-event', 'STALE-root-script', 'STALE-root-postman-id']) {
      assert.equal(s.includes(stale), false, `${stale} must not survive`);
    }
  });

  test('a stale root id IS replaced by the matching remote identity', () => {
    const local = localWithRootEvents();
    local.event[0].script.id = 'STALE-root-script';
    const remote = serverWithRootEvents();
    const out = injectRemoteIds(local, buildIdentityMap(remote), {});
    assert.equal(out.event[0].script.id, remote.collection.event[0].script.id);
    assert.equal(JSON.stringify(out).includes('STALE-root-script'), false);
  });

  test('TOP_LEVEL_SCRIPT_CONTENT_DRIFT_DETECTED', () => {
    for (const mutate of [
      (c) => { c.collection.event[1].script.exec = ['pm.test("tampered", () => {})']; },
      (c) => { c.collection.event[0].listen = 'test'; },
      (c) => { c.collection.event[0].script.type = 'text/plain'; },
      (c) => { c.collection.event.push({ listen: 'test', script: { type: 'text/javascript', exec: ['extra()'] } }); },
      (c) => { c.collection.event = [c.collection.event[0]]; },
    ]) {
      const remote = serverWithRootEvents();
      mutate(remote);
      assert.equal(semanticallyEqual(localWithRootEvents(), remote), false, 'root script content drift must be detected');
    }
  });

  test('AMBIGUOUS_TOP_LEVEL_EVENT_ID_NOT_GUESSED', () => {
    const remote = serverWithRootEvents();
    remote.collection.event[1].listen = 'prerequest';        // duplicate listen at the root
    const map = buildIdentityMap(remote);
    const root = map.get(COLLECTION_ROOT_KEY);
    assert.equal(root.events.has('prerequest'), false, 'ambiguous root event id must be dropped');
    assert.equal(root.scripts.has('prerequest'), false, 'ambiguous root script id must be dropped');
    const out = injectRemoteIds(localWithRootEvents(), map, {});
    assert.equal('id' in out.event[0], false, 'no id may be guessed');
    assert.equal('id' in out.event[0].script, false);
  });

  test('a new local root event receives no fabricated id', () => {
    const local = localWithRootEvents();
    local.event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: ['//'] } });
    // two 'prerequest' entries locally -> ambiguous, so nothing is assigned to either
    const out = injectRemoteIds(local, buildIdentityMap(serverWithRootEvents()), {});
    for (const e of out.event.filter((x) => x.listen === 'prerequest')) {
      assert.equal('id' in e, false);
      assert.equal('id' in e.script, false);
    }
  });

  test('a collection with no root events is unaffected', () => {
    for (const entry of COLLECTIONS) {
      const map = buildIdentityMap({ info: { name: 'x' }, item: [] });
      const root = map.get(COLLECTION_ROOT_KEY);
      assert.equal(root.events.size, 0);
      assert.equal(root.scripts.size, 0);
      void entry;
    }
    assert.doesNotThrow(() => injectRemoteIds({ info: { name: 'x' }, item: [] }, new Map(), {}));
  });

  test('post-PUT verification holds when the server mints new root ids', () => {
    const local = localWithRootEvents();
    const after = serverWithRootEvents({ id: 'bbbbbbbb-9999-8888-7777-666666666666' });
    after.collection.event[0].id = 'fresh-1';
    after.collection.event[0].script.id = 'fresh-2';
    after.collection.event[1].script.id = 'fresh-3';
    assert.equal(contentHash(local), contentHash(after));
  });
});

describe('the literal postman_id variant', () => {
  test('POSTMAN_ID_VARIANT_MODELLED at known managed positions', () => {
    const remote = serverWithRootEvents();
    remote.collection.info.postman_id = ID;
    remote.collection.item[0].postman_id = 'folder-postman-id';
    remote.collection.item[0].item[0].postman_id = 'request-postman-id';
    remote.collection.event[0].postman_id = 'root-event-postman-id';
    remote.collection.event[0].script.postman_id = 'root-script-postman-id';
    const n = normalizeForCompare(remote);
    assert.equal(n.info.postman_id, undefined);
    assert.equal(n.item[0].postman_id, undefined);
    assert.equal(n.item[0].item[0].postman_id, undefined);
    assert.equal(n.event[0].postman_id, undefined);
    assert.equal(n.event[0].script.postman_id, undefined);
    // and a remote differing only by those is still a NOOP
    assert.equal(semanticallyEqual(localWithRootEvents(), remote), true);
  });

  test('a managed postman_id is preserved into the payload', () => {
    const remote = serverWithRootEvents();
    remote.collection.item[0].item[0].postman_id = 'request-postman-id';
    remote.collection.event[0].script.postman_id = 'root-script-postman-id';
    const out = injectRemoteIds(localWithRootEvents(), buildIdentityMap(remote), {});
    assert.equal(out.item[0].item[0].postman_id, 'request-postman-id');
    assert.equal(out.event[0].script.postman_id, 'root-script-postman-id');
  });

  test('CONTENT_POSTMAN_ID_NOT_NORMALIZED_AWAY', () => {
    // A `postman_id` that is business data, in positions Postman does not own.
    const withContent = (c) => {
      c.collection.item[0].item[0].request.body = {
        mode: 'raw',
        raw: JSON.stringify({ address: '0xabc', postman_id: 'business-data' }),
      };
      c.collection.variable = [{ key: 'postman_id', value: 'a-variable-named-that' }];
      c.collection.item[0].item[0].request.headers = [{ key: 'X-Trace', value: 'postman_id=content' }];
      return c;
    };
    const local = withContent({ collection: localWithRootEvents() }).collection;
    const remote = withContent(serverWithRootEvents());
    const n = normalizeForCompare(remote);
    assert.match(n.item[0].item[0].request.body.raw, /business-data/);
    assert.equal(n.variable[0].key, 'postman_id');
    assert.equal(n.variable[0].value, 'a-variable-named-that');
    assert.equal(semanticallyEqual(local, remote), true, 'content postman_id must not cause drift either way');

    // changing that content IS detected
    const drifted = withContent(serverWithRootEvents());
    drifted.collection.item[0].item[0].request.body.raw = JSON.stringify({ address: '0xabc', postman_id: 'CHANGED' });
    assert.equal(semanticallyEqual(local, drifted), false);

    const driftedVar = withContent(serverWithRootEvents());
    driftedVar.collection.variable[0].value = 'CHANGED';
    assert.equal(semanticallyEqual(local, driftedVar), false);
  });

  test('a content object named postman_id survives the outbound payload', () => {
    const local = localWithRootEvents();
    local.item[0].item[0].request.body = { mode: 'raw', raw: '{"postman_id":"business-data"}' };
    const out = injectRemoteIds(local, buildIdentityMap(serverWithRootEvents()), {});
    assert.match(out.item[0].item[0].request.body.raw, /business-data/);
  });
});

describe('target identity is matched exactly when both forms are known', () => {
  const entry = COLLECTIONS[0];
  const bind = (remote, configuredId) => assertTargetBinding({
    entry, local: localWithRootEvents(), remote, configuredId,
  });

  test('the exact remote id is accepted', () => {
    assert.doesNotThrow(() => bind(serverWithRootEvents(), ID));
  });

  test('the exact remote uid is accepted', () => {
    assert.doesNotThrow(() => bind(serverWithRootEvents(), `${OWNER}-${ID}`));
  });

  test('WRONG_OWNER_UID_REJECTED when the remote supplied a uid', () => {
    assert.throws(() => bind(serverWithRootEvents(), `${OTHER_OWNER}-${ID}`),
      (e) => e instanceof SyncError && /not a representation of the identity the remote returned/.test(e.message));
    assert.equal(identityConsistent(`${OTHER_OWNER}-${ID}`, { id: ID, uid: `${OWNER}-${ID}` }), false);
  });

  test('with both forms known, only an exact match passes', () => {
    const both = { id: ID, uid: `${OWNER}-${ID}` };
    assert.equal(identityConsistent(ID, both), true);
    assert.equal(identityConsistent(`${OWNER}-${ID}`, both), true);
    for (const v of [`${OTHER_OWNER}-${ID}`, `prefix-${ID}`, `-${ID}`, ID.slice(1), `${ID}-suffix`]) {
      assert.equal(identityConsistent(v, both), false, `${v} must be rejected`);
    }
  });

  test('with only an id, no owner prefix is inferred', () => {
    assert.equal(identityConsistent(ID, { id: ID }), true);
    assert.equal(identityConsistent(`${OWNER}-${ID}`, { id: ID }), false, 'an owner prefix cannot be invented');
  });

  test('with only a uid, the bare id is derived because its syntax is provable', () => {
    const uid = `${OWNER}-${ID}`;
    assert.equal(identityConsistent(uid, { uid }), true);
    assert.equal(identityConsistent(ID, { uid }), true);
    assert.equal(identityConsistent(`${OTHER_OWNER}-${ID}`, { uid }), false);
    assert.equal(identityConsistent('nonsense', { uid }), false);
  });

  test('a remote exposing only postman_id still binds', () => {
    const remote = serverWithRootEvents();
    delete remote.collection.info._postman_id;
    delete remote.collection.info.uid;
    remote.collection.info.postman_id = ID;
    assert.doesNotThrow(() => bind(remote, ID));
  });
});
