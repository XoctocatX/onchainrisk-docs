/**
 * R3 — remote sub-entity ambiguity must be independent of managed-id presence and of list order,
 * and `info.postman_id` must round-trip when it is the only identity the remote supplies.
 *
 * The defect these cover: subMap() used to notice a duplicate key only once an EARLIER
 * occurrence had already inserted an id. A list whose first occurrence had no id therefore
 * looked unambiguous, and the second occurrence's ids were retained — identity guessed across an
 * ambiguous structural key, and only in one of the two orders.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECTIONS, COLLECTION_ROOT_KEY,
  unambiguousKeys, buildIdentityMap, injectRemoteIds, requestKey,
  normalizeForCompare, contentHash, semanticallyEqual, assertTargetBinding,
} from '../postman-sync.mjs';

const OWNER = '31415926';
const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PAID = 'OnChainRisk API';

const rootEvent = (listen, ids) => ({
  listen,
  ...(ids?.eventId ? { id: ids.eventId } : {}),
  script: {
    ...(ids?.scriptId ? { id: ids.scriptId } : {}),
    type: 'text/javascript',
    exec: [ids?.body ?? 'body()'],
  },
});

const shell = (extra = {}) => ({
  collection: {
    info: { _postman_id: ID, uid: `${OWNER}-${ID}`, name: PAID, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [],
    ...extra,
  },
});

describe('unambiguousKeys is the single shared decision', () => {
  test('a key appearing twice is excluded regardless of what the entries carry', () => {
    const list = [{ k: 'a' }, { k: 'a', id: 'x' }, { k: 'b', id: 'y' }];
    assert.deepEqual([...unambiguousKeys(list, (x) => x.k)].sort(), ['b']);
  });
  test('order does not change the verdict', () => {
    const a = [{ k: 'a' }, { k: 'a', id: 'x' }];
    const b = [{ k: 'a', id: 'x' }, { k: 'a' }];
    assert.equal(unambiguousKeys(a, (x) => x.k).has('a'), false);
    assert.equal(unambiguousKeys(b, (x) => x.k).has('a'), false);
  });
  test('non-objects and empty lists are handled', () => {
    assert.equal(unambiguousKeys(undefined, (x) => x.k).size, 0);
    assert.equal(unambiguousKeys([null, 'str', { k: 'a' }], (x) => x.k).has('a'), true);
  });
});

describe('REMOTE_DUPLICATE_ROOT_ONE_ID_NOT_GUESSED — both orders', () => {
  const withIds = rootEvent('test', { eventId: 'event-2', scriptId: 'script-2', body: 'second' });
  const without = rootEvent('test', { body: 'first' });

  for (const [label, order] of [['no-id occurrence first', [without, withIds]], ['id occurrence first', [withIds, without]]]) {
    test(label, () => {
      const root = buildIdentityMap(shell({ event: order })).get(COLLECTION_ROOT_KEY);
      assert.equal(root.events.has('test'), false, 'no event id may be mapped');
      assert.equal(root.scripts.has('test'), false, 'no script id may be mapped');
      // and nothing is injected into a local collection either
      const local = { info: { name: PAID }, item: [], event: [rootEvent('test', { body: 'first' })] };
      const out = injectRemoteIds(local, buildIdentityMap(shell({ event: order })), {});
      assert.equal('id' in out.event[0], false);
      assert.equal('id' in out.event[0].script, false);
    });
  }

  test('duplicate listen where only ONE event has a script at all', () => {
    for (const order of [
      [{ listen: 'test' }, rootEvent('test', { eventId: 'e9', scriptId: 's9' })],
      [rootEvent('test', { eventId: 'e9', scriptId: 's9' }), { listen: 'test' }],
    ]) {
      const root = buildIdentityMap(shell({ event: order })).get(COLLECTION_ROOT_KEY);
      assert.equal(root.events.has('test'), false);
      assert.equal(root.scripts.has('test'), false, 'a script id must not be assigned just because the other duplicate has no script');
    }
  });

  test('a genuinely unique root listen still maps', () => {
    const root = buildIdentityMap(shell({
      event: [rootEvent('prerequest', { eventId: 'e1', scriptId: 's1' }), rootEvent('test', { eventId: 'e2', scriptId: 's2' })],
    })).get(COLLECTION_ROOT_KEY);
    assert.equal(root.events.get('prerequest').id, 'e1');
    assert.equal(root.scripts.get('test').id, 's2');
  });
});

describe('REMOTE_DUPLICATE_ITEM_EVENT_ONE_ID_NOT_GUESSED — both orders', () => {
  const item = (events) => shell({
    item: [{
      name: 'Analysis', id: 'f1',
      item: [{ name: 'POST check', id: 'r1', request: { method: 'POST', url: { raw: '{{base_url}}/api/v1/check' } }, event: events }],
    }],
  });
  const key = requestKey(['Analysis'], 'POST', { raw: '{{base_url}}/api/v1/check' });

  for (const [label, order] of [
    ['no-id first', [rootEvent('test', { body: 'a' }), rootEvent('test', { eventId: 'e2', scriptId: 's2', body: 'b' })]],
    ['id first', [rootEvent('test', { eventId: 'e2', scriptId: 's2', body: 'b' }), rootEvent('test', { body: 'a' })]],
  ]) {
    test(label, () => {
      const hit = buildIdentityMap(item(order)).get(key);
      assert.equal(hit.events.has('test'), false);
      assert.equal(hit.scripts.has('test'), false);
    });
  }

  test('a unique item event still maps', () => {
    const hit = buildIdentityMap(item([rootEvent('test', { eventId: 'e2', scriptId: 's2' })])).get(key);
    assert.equal(hit.events.get('test').id, 'e2');
    assert.equal(hit.scripts.get('test').id, 's2');
  });
});

describe('REMOTE_DUPLICATE_RESPONSE_ONE_ID_NOT_GUESSED — both orders', () => {
  const withResponses = (responses) => shell({
    item: [{
      name: 'Analysis', id: 'f1',
      item: [{ name: 'POST check', id: 'r1', request: { method: 'POST', url: { raw: '{{base_url}}/api/v1/check' } }, response: responses }],
    }],
  });
  const key = requestKey(['Analysis'], 'POST', { raw: '{{base_url}}/api/v1/check' });
  const noId = { name: '200 ok', code: 200, body: '{"a":1}' };
  const withId = { name: '200 ok', id: 'x2', uid: `${OWNER}-x2`, code: 200, body: '{"a":2}' };

  for (const [label, order] of [['no-id first', [noId, withId]], ['id first', [withId, noId]]]) {
    test(label, () => {
      const hit = buildIdentityMap(withResponses(order)).get(key);
      assert.equal(hit.responses.has('200 ok'), false, 'a duplicated example name must map no id');
    });
  }

  test('a unique response name still maps both id and uid', () => {
    const hit = buildIdentityMap(withResponses([withId])).get(key);
    assert.deepEqual(hit.responses.get('200 ok'), { id: 'x2', uid: `${OWNER}-x2` });
  });
});

describe('REMOTE_DUPLICATE_ORDER_INDEPENDENT', () => {
  test('every duplicate domain gives the same verdict in both orders', () => {
    const A = { name: 'dup', id: 'a1' };
    const B = { name: 'dup' };
    assert.equal(unambiguousKeys([A, B], (x) => x.name).has('dup'), unambiguousKeys([B, A], (x) => x.name).has('dup'));
    assert.equal(unambiguousKeys([A, B], (x) => x.name).has('dup'), false);
  });
});

describe('INFO_POSTMAN_ID_PRESERVED', () => {
  const entry = COLLECTIONS[0];
  const onlyPostmanId = () => {
    const c = shell({ item: [] });
    delete c.collection.info._postman_id;
    delete c.collection.info.uid;
    c.collection.info.postman_id = ID;
    return c;
  };
  const local = () => ({ info: { name: PAID, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] });

  test('binding succeeds and the exact remote postman_id reaches the payload', () => {
    const remote = onlyPostmanId();
    const bound = assertTargetBinding({ entry, local: local(), remote, configuredId: ID });
    assert.equal(bound.id, ID);
    assert.deepEqual(bound.remoteInfoIdentity, { postman_id: ID });
    const out = injectRemoteIds(local(), buildIdentityMap(remote), { remoteInfoIdentity: bound.remoteInfoIdentity });
    assert.equal(out.info.postman_id, ID, 'the managed identity must be restored');
  });

  test('nothing is fabricated: no _postman_id and no uid appear', () => {
    const remote = onlyPostmanId();
    const bound = assertTargetBinding({ entry, local: local(), remote, configuredId: ID });
    const out = injectRemoteIds(local(), buildIdentityMap(remote), { remoteInfoIdentity: bound.remoteInfoIdentity });
    assert.equal('_postman_id' in out.info, false);
    assert.equal('uid' in out.info, false);
  });

  test('normalized content stays equal across the round trip', () => {
    const remote = onlyPostmanId();
    const bound = assertTargetBinding({ entry, local: local(), remote, configuredId: ID });
    const out = injectRemoteIds(local(), buildIdentityMap(remote), { remoteInfoIdentity: bound.remoteInfoIdentity });
    assert.equal(contentHash(out), contentHash(local()));
    assert.equal(semanticallyEqual(out, remote), true);
  });

  test('all three info identity representations are restored when present', () => {
    const remote = shell({ item: [] });
    remote.collection.info.postman_id = ID;
    const bound = assertTargetBinding({ entry, local: local(), remote, configuredId: ID });
    const out = injectRemoteIds(local(), buildIdentityMap(remote), { remoteInfoIdentity: bound.remoteInfoIdentity });
    assert.equal(out.info._postman_id, ID);
    assert.equal(out.info.postman_id, ID);
    assert.equal(out.info.uid, `${OWNER}-${ID}`);
  });

  test('STALE_LOCAL_INFO_POSTMAN_ID_STRIPPED when the remote does not supply one', () => {
    const l = local();
    l.info.postman_id = 'STALE-local-postman-id';
    l.info._postman_id = 'STALE-local-underscore';
    const out = injectRemoteIds(l, new Map(), {});          // no remote identity at all
    assert.equal('postman_id' in out.info, false);
    assert.equal('_postman_id' in out.info, false);
    assert.equal(JSON.stringify(out).includes('STALE-local'), false);
  });

  test('a stale local info.postman_id is replaced, not merged', () => {
    const l = local();
    l.info.postman_id = 'STALE-local-postman-id';
    const remote = onlyPostmanId();
    const bound = assertTargetBinding({ entry, local: l, remote, configuredId: ID });
    const out = injectRemoteIds(l, buildIdentityMap(remote), { remoteInfoIdentity: bound.remoteInfoIdentity });
    assert.equal(out.info.postman_id, ID);
    assert.equal(JSON.stringify(out).includes('STALE-local-postman-id'), false);
  });
});

describe('position-aware review of the managed variants', () => {
  test('event and script positions no longer normalize a speculative uid', () => {
    // `uid` is not documented on event/script and no modelled response returns one, so a `uid`
    // appearing there is treated as CONTENT: it stays, and a change to it is real drift.
    const remote = shell({ event: [{ listen: 'test', id: 'e1', uid: 'extension-value', script: { id: 's1', type: 'text/javascript', exec: ['x()'] } }] });
    const n = normalizeForCompare(remote);
    assert.equal(n.event[0].id, undefined, 'event id is managed');
    assert.equal(n.event[0].uid, 'extension-value', 'event uid is NOT stripped');
    const drifted = shell({ event: [{ listen: 'test', id: 'e1', uid: 'CHANGED', script: { id: 's1', type: 'text/javascript', exec: ['x()'] } }] });
    assert.equal(semanticallyEqual(remote, drifted), false, 'a change to it must be detected');
  });

  test('item and response positions still normalize uid, which the API does return there', () => {
    const remote = shell({
      item: [{ name: 'F', id: 'f1', uid: `${OWNER}-f1`, item: [
        { name: 'R', id: 'r1', uid: `${OWNER}-r1`, request: { method: 'GET', url: { raw: '{{base_url}}/api/x' } },
          response: [{ name: '200', id: 'x1', uid: `${OWNER}-x1`, code: 200, body: '{}' }] },
      ] }],
    });
    const n = normalizeForCompare(remote);
    assert.equal(n.item[0].uid, undefined);
    assert.equal(n.item[0].item[0].uid, undefined);
    assert.equal(n.item[0].item[0].response[0].uid, undefined);
  });

  test('postman_id is still managed at event and script positions', () => {
    const remote = shell({ event: [{ listen: 'test', postman_id: 'e-pm', script: { postman_id: 's-pm', type: 'text/javascript', exec: ['x()'] } }] });
    const n = normalizeForCompare(remote);
    assert.equal(n.event[0].postman_id, undefined);
    assert.equal(n.event[0].script.postman_id, undefined);
  });

  test('no blanket recursive stripping: content keys named id/uid/postman_id survive', () => {
    const remote = shell({
      variable: [{ key: 'uid', value: 'a-variable-named-uid' }],
      item: [{ name: 'F', id: 'f1', item: [{
        name: 'R', id: 'r1',
        request: { method: 'POST', url: { raw: '{{base_url}}/api/x' }, body: { mode: 'raw', raw: '{"id":1,"uid":"u","postman_id":"p"}' } },
      }] }],
    });
    const n = normalizeForCompare(remote);
    assert.equal(n.variable[0].key, 'uid');
    assert.equal(n.variable[0].value, 'a-variable-named-uid');
    assert.match(n.item[0].item[0].request.body.raw, /"id":1/);
    assert.match(n.item[0].item[0].request.body.raw, /"uid":"u"/);
    assert.match(n.item[0].item[0].request.body.raw, /"postman_id":"p"/);
  });

  test('the real collections are unaffected by the variant trim', async () => {
    const { readLocal } = await import('../postman-sync.mjs');
    for (const e of COLLECTIONS) {
      const local = readLocal(e.file);
      // both roles still hash deterministically and map without ambiguity after the trim
      assert.match(contentHash(local), /^[0-9a-f]{64}$/);
      assert.doesNotThrow(() => buildIdentityMap(local, { label: e.file }));
    }
  });
});
