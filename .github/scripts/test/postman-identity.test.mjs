/**
 * R1 — target binding and the full Postman-managed identity model.
 *
 * Fixtures are shaped like the CURRENT Postman collection API response, not like our exported
 * file: items and responses carry both `id` and `uid`, event scripts carry an `id`, and the
 * collection info carries `_postman_id`, `uid` and `owner`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECTIONS, ACTIVATION_VAR, SyncError,
  stripManaged, normalizeForCompare, contentHash, semanticallyEqual,
  buildIdentityMap, injectRemoteIds, identityConsistent, assertTargetBinding,
  autopublishEnabled, readLocal, requestKey,
} from '../postman-sync.mjs';

const OWNER = '31415926';
const PAID = 'OnChainRisk API';
const SANDBOX = 'OnChainRisk API';

/** What Postman actually returns: managed identity on every structural entity. */
function serverShaped(name = PAID, { id = 'aaaaaaaa-1111-2222-3333-444444444444' } = {}) {
  return {
    collection: {
      info: {
        _postman_id: id,
        uid: `${OWNER}-${id}`,
        name,
        owner: OWNER,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        updatedAt: '2026-10-11T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUpdatedBy: OWNER,
        description: 'shared prose',
      },
      item: [
        {
          name: 'Analysis', id: 'f1111111-0000-0000-0000-000000000001', uid: `${OWNER}-f1111111-0000-0000-0000-000000000001`,
          item: [
            {
              name: 'POST check', id: 'r1111111-0000-0000-0000-000000000002', uid: `${OWNER}-r1111111-0000-0000-0000-000000000002`,
              request: {
                method: 'POST',
                url: { raw: '{{base_url}}/api/v1/check' },
                body: { mode: 'raw', raw: '{"address":"0xabc","id":"content-id-must-survive"}' },
              },
              event: [
                { listen: 'test', id: 'e1111111-0000-0000-0000-000000000003', script: { id: 's1111111-0000-0000-0000-000000000004', type: 'text/javascript', exec: ['pm.test("ok", () => {})'] } },
                { listen: 'prerequest', id: 'e1111111-0000-0000-0000-000000000005', script: { id: 's1111111-0000-0000-0000-000000000006', type: 'text/javascript', exec: ['// noop'] } },
              ],
              response: [
                { name: '200 ok', id: 'x1111111-0000-0000-0000-000000000007', uid: `${OWNER}-x1111111-0000-0000-0000-000000000007`, code: 200, body: '{"riskScore":42,"id":"example-content-id"}' },
                { name: '422 invalid', id: 'x1111111-0000-0000-0000-000000000008', uid: `${OWNER}-x1111111-0000-0000-0000-000000000008`, code: 422, body: '{"error":"VALIDATION_ERROR"}' },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** The same collection as checked in: our content, no managed identity. */
function localShaped(name = PAID) {
  const c = JSON.parse(JSON.stringify(serverShaped(name).collection));
  const strip = (o) => {
    for (const k of ['_postman_id', 'uid', 'owner', 'updatedAt', 'createdAt', 'lastUpdatedBy']) delete o[k];
  };
  strip(c.info);
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      delete n.id; delete n.uid;
      for (const r of n.response ?? []) { delete r.id; delete r.uid; }
      for (const e of n.event ?? []) { delete e.id; if (e.script) delete e.script.id; }
      if (n.item) walk(n.item);
    }
  };
  walk(c.item);
  return c;
}

describe('BLOCKER 1 — the role is bound to the remote target', () => {
  const paidEntry = COLLECTIONS[0];
  const sandboxEntry = COLLECTIONS[0];

  test('the single collection role declares a hard-coded expected name', () => {
    // There were TWO per-tier collections, and the pair of roles had to be told apart. There is
    // ONE now, so both references resolve to it — and the property that survives is the one that
    // mattered: the expected name is hard-coded on the entry, never read off the remote.
    assert.equal(COLLECTIONS.length, 1);
    assert.equal(paidEntry.expectedName, PAID);
    assert.equal(paidEntry, sandboxEntry);
  });

  test('a correct role / name / identity is allowed to proceed', () => {
    const remote = serverShaped(PAID);
    const bound = assertTargetBinding({
      entry: paidEntry, local: localShaped(PAID), remote, configuredId: remote.collection.info._postman_id,
    });
    assert.equal(bound.id, remote.collection.info._postman_id);
    assert.equal(bound.uid, remote.collection.info.uid);
    assert.deepEqual(Object.keys(bound.remoteInfoIdentity).sort(), ['_postman_id', 'uid']);
  });

  test('a uid is an accepted representation of the same collection', () => {
    const remote = serverShaped(PAID);
    assert.doesNotThrow(() => assertTargetBinding({
      entry: paidEntry, local: localShaped(PAID), remote, configuredId: remote.collection.info.uid,
    }));
  });

  test('the collection variable pointing at ANOTHER collection FAILS', () => {
    // The old pair of tests swapped the two per-tier collections against each other. With one
    // collection the equivalent mistake is the id pointing at some other collection entirely —
    // the deprecated sandbox cloud collection, for instance, which is retained and must never be
    // written to by this publisher.
    const remote = serverShaped('OnChainRisk Sandbox API (DEPRECATED)');
    assert.throws(() => assertTargetBinding({
      entry: paidEntry, local: localShaped(PAID), remote, configuredId: remote.collection.info._postman_id,
    }), (e) => e instanceof SyncError
      && /points at a collection named "OnChainRisk Sandbox API \(DEPRECATED\)"/.test(e.message)
      && /may only update "OnChainRisk API"/.test(e.message)
      && /swapped or mistyped variable/.test(e.message));
  });

  test('a LOCAL file whose name does not match the role FAILS before any id is trusted', () => {
    // The other half of the swap: the binding asserts the LOCAL name too, so a mis-copied file
    // cannot be published under a role it does not belong to. This was previously covered by
    // pointing the sandbox role at the paid file.
    const remote = serverShaped(PAID);
    assert.throws(() => assertTargetBinding({
      entry: paidEntry, local: localShaped('OnChainRisk Sandbox API'), remote,
      configuredId: remote.collection.info._postman_id,
    }), (e) => e instanceof SyncError && /OnChainRisk Sandbox API/.test(e.message));
  });

  test('an unrelated existing editable collection FAILS', () => {
    const remote = serverShaped('Someone Else Team Workspace');
    assert.throws(() => assertTargetBinding({
      entry: paidEntry, local: localShaped(PAID), remote, configuredId: remote.collection.info._postman_id,
    }), /Someone Else Team Workspace/);
  });

  test('a local file whose name is not the role expectation FAILS', () => {
    assert.throws(() => assertTargetBinding({
      entry: paidEntry, local: localShaped('Renamed Locally'), remote: serverShaped(PAID),
      configuredId: serverShaped(PAID).collection.info._postman_id,
    }), /Refusing to publish a file that is not the expected collection/);
  });

  test('a remote with no usable identity FAILS', () => {
    const remote = serverShaped(PAID);
    delete remote.collection.info._postman_id;
    delete remote.collection.info.uid;
    assert.throws(() => assertTargetBinding({
      entry: paidEntry, local: localShaped(PAID), remote, configuredId: 'whatever',
    }), /exposes no usable identity/);
  });

  test('a configured id inconsistent with the returned identity FAILS', () => {
    const remote = serverShaped(PAID);
    assert.throws(() => assertTargetBinding({
      entry: paidEntry, local: localShaped(PAID), remote, configuredId: 'bbbbbbbb-9999-9999-9999-999999999999',
    }), /not a representation of the identity the remote returned/);
  });

  test('identityConsistent accepts id and uid forms and nothing else', () => {
    // R2 tightened this: when both forms are known, only an EXACT match passes. The looser rule
    // this test used to assert ("anything ending in -id") would have admitted a uid carrying
    // someone else's owner prefix. See postman-collection-level.test.mjs for the full matrix.
    const id = 'aaaa-bbbb';
    const uid = `${OWNER}-${id}`;
    assert.equal(identityConsistent(id, { id, uid }), true);
    assert.equal(identityConsistent(uid, { id, uid }), true);
    assert.equal(identityConsistent(uid, { id }), false);         // owner prefix is never inferred
    assert.equal(identityConsistent(id, { uid }), true);          // derivable by dropping the prefix
    assert.equal(identityConsistent('other', { id, uid }), false);
    assert.equal(identityConsistent('', { id, uid }), false);
    assert.equal(identityConsistent(undefined, { id, uid }), false);
    assert.equal(identityConsistent(id, {}), false);
  });

  test('the name is an assertion, never a lookup: no listing endpoint is referenced', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../postman-sync.mjs', import.meta.url), 'utf8');
    assert.equal(/GET.*\/collections'/.test(src), false);
    assert.equal(src.includes("postman('GET', '/collections'"), false);
    assert.equal(src.includes("postman('POST'"), false);
  });
});

describe('BLOCKER 2 — managed identity is modelled at every position Postman owns', () => {
  test('a remote differing ONLY by managed identity is a semantic NOOP', () => {
    assert.equal(semanticallyEqual(localShaped(PAID), serverShaped(PAID)), true);
  });

  test('normalization removes item id/uid, response id/uid, event id and script id', () => {
    const n = normalizeForCompare(serverShaped(PAID));
    const folder = n.item[0];
    const req = folder.item[0];
    for (const [label, holder] of [['folder', folder], ['request', req], ['response', req.response[0]]]) {
      assert.equal(holder.id, undefined, `${label}.id`);
      assert.equal(holder.uid, undefined, `${label}.uid`);
    }
    assert.equal(req.event[0].id, undefined, 'event.id');
    assert.equal(req.event[0].script.id, undefined, 'event.script.id');
    assert.equal(n.info._postman_id, undefined);
    assert.equal(n.info.uid, undefined);
    assert.equal(n.info.owner, undefined);
    assert.equal(n.info.updatedAt, undefined);
  });

  test('an id inside OUR content is NOT normalized away', () => {
    const n = normalizeForCompare(serverShaped(PAID));
    const req = n.item[0].item[0];
    assert.match(req.request.body.raw, /content-id-must-survive/);
    assert.match(req.response[0].body, /example-content-id/);
    // and a content id difference is therefore detected
    const drifted = serverShaped(PAID);
    drifted.collection.item[0].item[0].request.body.raw = '{"address":"0xabc","id":"CHANGED"}';
    assert.equal(semanticallyEqual(localShaped(PAID), drifted), false);
  });

  test('every managed identity is preserved into the outbound payload', () => {
    const remote = serverShaped(PAID);
    const map = buildIdentityMap(remote);
    const out = injectRemoteIds(localShaped(PAID), map, {
      remoteInfoIdentity: { _postman_id: remote.collection.info._postman_id, uid: remote.collection.info.uid },
    });
    const rf = remote.collection.item[0];
    const rr = rf.item[0];
    const of_ = out.item[0];
    const or_ = of_.item[0];
    assert.equal(of_.id, rf.id, 'folder id');
    assert.equal(of_.uid, rf.uid, 'folder uid');
    assert.equal(or_.id, rr.id, 'request id');
    assert.equal(or_.uid, rr.uid, 'request uid');
    assert.equal(or_.response[0].id, rr.response[0].id, 'response id');
    assert.equal(or_.response[0].uid, rr.response[0].uid, 'response uid');
    assert.equal(or_.response[1].id, rr.response[1].id, 'second response id');
    const byListen = (evts, l) => evts.find((e) => e.listen === l);
    assert.equal(byListen(or_.event, 'test').id, byListen(rr.event, 'test').id, 'event id');
    assert.equal(byListen(or_.event, 'test').script.id, byListen(rr.event, 'test').script.id, 'script id');
    assert.equal(byListen(or_.event, 'prerequest').script.id, byListen(rr.event, 'prerequest').script.id, 'second script id');
    assert.equal(out.info._postman_id, remote.collection.info._postman_id);
    assert.equal(out.info.uid, remote.collection.info.uid);
  });

  test('STALE local managed ids never survive into the payload', () => {
    const local = localShaped(PAID);
    // a checked-in file that somehow carries ids from an old export
    local.item[0].id = 'STALE-folder';
    local.item[0].item[0].id = 'STALE-request';
    local.item[0].item[0].uid = 'STALE-uid';
    local.item[0].item[0].response[0].id = 'STALE-response';
    local.item[0].item[0].event[0].script.id = 'STALE-script';
    local.info._postman_id = 'STALE-collection';
    const out = injectRemoteIds(local, new Map(), {});     // no remote match at all
    const s = JSON.stringify(out);
    for (const stale of ['STALE-folder', 'STALE-request', 'STALE-uid', 'STALE-response', 'STALE-script', 'STALE-collection']) {
      assert.equal(s.includes(stale), false, `${stale} must not leak into a full replacement`);
    }
  });

  test('a stale local id IS replaced by the matching remote identity', () => {
    const local = localShaped(PAID);
    local.item[0].item[0].id = 'STALE-request';
    const remote = serverShaped(PAID);
    const out = injectRemoteIds(local, buildIdentityMap(remote), {});
    assert.equal(out.item[0].item[0].id, remote.collection.item[0].item[0].id);
    assert.equal(JSON.stringify(out).includes('STALE-request'), false);
  });

  test('a new local entity receives no fabricated managed id', () => {
    const local = localShaped(PAID);
    local.item[0].item.push({
      name: 'GET new', request: { method: 'GET', url: { raw: '{{base_url}}/api/v1/new' } },
      response: [{ name: '200 ok', code: 200, body: '{}' }],
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['//'] } }],
    });
    const out = injectRemoteIds(local, buildIdentityMap(serverShaped(PAID)), {});
    const added = out.item[0].item.find((x) => x.name === 'GET new');
    for (const key of ['id', 'uid', '_postman_id']) assert.equal(key in added, false, `item.${key}`);
    assert.equal('id' in added.response[0], false);
    assert.equal('id' in added.event[0], false);
    assert.equal('id' in added.event[0].script, false);
  });

  test('an entity removed locally stays removed', () => {
    const local = localShaped(PAID);
    local.item[0].item[0].response = [local.item[0].item[0].response[0]];
    const remote = serverShaped(PAID);
    const out = injectRemoteIds(local, buildIdentityMap(remote), {});
    assert.equal(out.item[0].item[0].response.length, 1);
    assert.equal(JSON.stringify(out).includes(remote.collection.item[0].item[0].response[1].id), false);
  });

  test('an ambiguous response-example name omits that id (documented recreation)', () => {
    const remote = serverShaped(PAID);
    remote.collection.item[0].item[0].response[1].name = '200 ok';   // duplicate name
    const map = buildIdentityMap(remote);
    const hit = map.get(requestKey(['Analysis'], 'POST', { raw: '{{base_url}}/api/v1/check' }));
    assert.equal(hit.responses.has('200 ok'), false);
    const out = injectRemoteIds(localShaped(PAID), map, {});
    assert.equal('id' in out.item[0].item[0].response[0], false);
  });

  test('two events with the same listen omit the script id rather than guessing', () => {
    const remote = serverShaped(PAID);
    remote.collection.item[0].item[0].event[1].listen = 'test';      // duplicate listen
    const map = buildIdentityMap(remote);
    const hit = map.get(requestKey(['Analysis'], 'POST', { raw: '{{base_url}}/api/v1/check' }));
    assert.equal(hit.scripts.has('test'), false);
    assert.equal(hit.events.has('test'), false);
  });

  test('meaningful script content drift is still detected', () => {
    const remote = serverShaped(PAID);
    remote.collection.item[0].item[0].event[0].script.exec = ['pm.test("tampered", () => {})'];
    assert.equal(semanticallyEqual(localShaped(PAID), remote), false);
  });

  test('meaningful response content drift is still detected', () => {
    for (const mutate of [
      (c) => { c.collection.item[0].item[0].response[0].body = '{"riskScore":99}'; },
      (c) => { c.collection.item[0].item[0].response[0].code = 418; },
      (c) => { c.collection.item[0].item[0].response[0].name = 'Renamed example'; },
    ]) {
      const remote = serverShaped(PAID);
      mutate(remote);
      assert.equal(semanticallyEqual(localShaped(PAID), remote), false);
    }
  });

  test('no remote content field is copied back', () => {
    const remote = serverShaped(PAID);
    remote.collection.info.description = 'REMOTE PROSE';
    remote.collection.item[0].item[0].event[0].script.exec = ['remoteOnly()'];
    remote.collection.item[0].item[0].response[0].body = '{"remote":true}';
    remote.collection.variable = [{ key: 'remote_only', value: 'leak' }];
    const out = injectRemoteIds(localShaped(PAID), buildIdentityMap(remote), {});
    const s = JSON.stringify(out);
    assert.equal(s.includes('REMOTE PROSE'), false);
    assert.equal(s.includes('remoteOnly()'), false);
    assert.equal(s.includes('"remote":true'), false);
    assert.equal(s.includes('remote_only'), false);
    assert.equal(out.info.description, 'shared prose');
  });

  test('post-PUT verification passes when the server returns NEW managed ids', () => {
    // Postman may mint fresh ids for recreated entities; content equality must still hold.
    const local = localShaped(PAID);
    const after = serverShaped(PAID, { id: 'cccccccc-5555-6666-7777-888888888888' });
    const walk = (nodes, n = { i: 0 }) => {
      for (const x of nodes ?? []) {
        x.id = `fresh-${n.i++}`; x.uid = `${OWNER}-fresh-${n.i++}`;
        for (const r of x.response ?? []) { r.id = `fresh-${n.i++}`; r.uid = `${OWNER}-fresh-${n.i++}`; }
        for (const e of x.event ?? []) { e.id = `fresh-${n.i++}`; if (e.script) e.script.id = `fresh-${n.i++}`; }
        if (x.item) walk(x.item, n);
      }
    };
    walk(after.collection.item);
    assert.equal(contentHash(local), contentHash(after), 'fresh managed ids must not break verification');
  });

  test('stripManaged does not mutate its input', () => {
    const remote = serverShaped(PAID);
    const before = JSON.stringify(remote);
    stripManaged(remote);
    assert.equal(JSON.stringify(remote), before);
  });

  test('both real checked-in collections round-trip with a server-shaped remote', () => {
    for (const entry of COLLECTIONS) {
      const local = readLocal(entry.file);
      const remote = { collection: JSON.parse(JSON.stringify(local)) };
      let n = 0;
      remote.collection.info._postman_id = 'cloud-id';
      remote.collection.info.uid = `${OWNER}-cloud-id`;
      const walk = (nodes) => {
        for (const x of nodes ?? []) {
          x.id = `i-${n++}`; x.uid = `${OWNER}-i-${n++}`;
          for (const r of x.response ?? []) { r.id = `x-${n++}`; r.uid = `${OWNER}-x-${n++}`; }
          for (const e of x.event ?? []) { e.id = `e-${n++}`; if (e.script) e.script.id = `s-${n++}`; }
          if (x.item) walk(x.item);
        }
      };
      walk(remote.collection.item);
      assert.equal(semanticallyEqual(local, remote), true, `${entry.file} must be a NOOP against its own server shape`);
      const out = injectRemoteIds(local, buildIdentityMap(remote), {});
      assert.equal(contentHash(out), contentHash(local), `${entry.file} content must be unchanged by injection`);
      assert.equal(JSON.stringify(out).includes('"i-0"'), true, `${entry.file} must carry remote ids`);
    }
  });
});

describe('first-activation gate', () => {
  test(`only the exact string 'true' enables publication`, () => {
    assert.equal(autopublishEnabled({ [ACTIVATION_VAR]: 'true' }), true);
    for (const v of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
      assert.equal(autopublishEnabled({ [ACTIVATION_VAR]: v }), false, `${JSON.stringify(v)} must not enable`);
    }
    assert.equal(autopublishEnabled({}), false);
  });

  test('the gate is enforced in the workflow AND in the script', async () => {
    const { readFileSync } = await import('node:fs');
    const wf = readFileSync(new URL('../../workflows/publish-postman.yml', import.meta.url), 'utf8');
    const src = readFileSync(new URL('../postman-sync.mjs', import.meta.url), 'utf8');
    const publishJob = wf.slice(wf.indexOf('  publish:'), wf.indexOf('  verify-only:'));
    assert.match(publishJob, /vars\.POSTMAN_AUTOPUBLISH_ENABLED == 'true'/);
    assert.match(src, /autopublishEnabled/);
    // and the read-only job is deliberately NOT gated on it
    const verifyJob = wf.slice(wf.indexOf('  verify-only:'));
    assert.equal(verifyJob.includes("vars.POSTMAN_AUTOPUBLISH_ENABLED == 'true'"), false);
  });

  test('the publish job passes the activation variable through to the script', async () => {
    const { readFileSync } = await import('node:fs');
    const wf = readFileSync(new URL('../../workflows/publish-postman.yml', import.meta.url), 'utf8');
    const publishJob = wf.slice(wf.indexOf('  publish:'), wf.indexOf('  verify-only:'));
    assert.match(publishJob, /POSTMAN_AUTOPUBLISH_ENABLED: \$\{\{ vars\.POSTMAN_AUTOPUBLISH_ENABLED \}\}/);
  });

  test('a pull request can never publish, whatever the variable says', async () => {
    const { readFileSync } = await import('node:fs');
    const wf = readFileSync(new URL('../../workflows/publish-postman.yml', import.meta.url), 'utf8');
    const publishJob = wf.slice(wf.indexOf('  publish:'), wf.indexOf('  verify-only:'));
    assert.match(publishJob, /github\.ref == 'refs\/heads\/main'/);
    assert.equal(publishJob.includes('pull_request'), false);
    // the validation job — the only one a pull request runs — never sees the secret
    const validateJob = wf.slice(wf.indexOf('  validate:'), wf.indexOf('  publish:'));
    assert.equal(validateJob.includes('secrets.'), false, 'the PR-reachable job must not reference any secret');
    assert.equal(wf.slice(wf.indexOf('  publish:')).includes('secrets.POSTMAN_API_KEY'), true);
  });
});
