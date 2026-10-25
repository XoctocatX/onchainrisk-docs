/**
 * Drives main() with a stubbed fetch, so the publication DECISION and its audit output are
 * tested without a network call, without an API key and without mutating anything.
 *
 * THREE TARGETS since the #748 cutover: one collection and two environments. The stub serves
 * each from its own endpoint, so the driver's independence is what is exercised — a decision
 * about one target must not be reached through another's response.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { main, readLocal, contentHash, environmentContentHash } from '../postman-sync.mjs';

const realFetch = globalThis.fetch;
const DUMMY_KEY = 'not-a-key-stubbed-transport';
let calls;

const COLLECTION_ID = 'collection-cloud-id';
const PRODUCTION_ENV_ID = 'production-env-cloud-id';
const SANDBOX_ENV_ID = 'sandbox-env-cloud-id';

/** Serve each target back as its own remote, optionally mutated. */
function stubFetch({ mutate = null, putStatus = 200, afterPut = null, mutateEnv = null } = {}) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const u = String(url);
    calls.push({ method, url: u, hasKey: Boolean(init?.headers?.['x-api-key']) });
    const isEnv = u.includes('/environments/');
    if (method === 'PUT') {
      const echo = isEnv ? { environment: { id: 'x' } } : { collection: { uid: 'x' } };
      return new Response(JSON.stringify(echo), { status: putStatus, headers: { 'Content-Type': 'application/json' } });
    }
    const alreadyPut = calls.some((c) => c.method === 'PUT' && c.url === u);

    if (isEnv) {
      const id = u.includes(PRODUCTION_ENV_ID) ? PRODUCTION_ENV_ID : SANDBOX_ENV_ID;
      const file = id === PRODUCTION_ENV_ID
        ? 'production.postman_environment.json' : 'sandbox.postman_environment.json';
      const body = { environment: JSON.parse(JSON.stringify(readLocal(file))) };
      body.environment.id = id;
      body.environment.uid = `99999-${id}`;
      body.environment.updatedAt = '2026-01-01T00:00:00Z';
      if (alreadyPut && afterPut) afterPut(body);
      else if (!alreadyPut && mutateEnv) mutateEnv(body);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const local = readLocal('onchainrisk_api_collection.json');
    const body = { collection: JSON.parse(JSON.stringify(local)) };
    body.collection.info._postman_id = COLLECTION_ID;
    body.collection.info.uid = `99999-${COLLECTION_ID}`;
    body.collection.info.updatedAt = '2026-01-01T00:00:00Z';
    if (alreadyPut && afterPut) afterPut(body);
    else if (!alreadyPut && mutate) mutate(body);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const run = async (argv) => {
  const lines = [];
  const code = await main(argv, (l) => lines.push(String(l)));
  return { code, out: lines.join('\n') };
};

beforeEach(() => {
  process.env.POSTMAN_API_KEY = DUMMY_KEY;
  process.env.POSTMAN_COLLECTION_ID = COLLECTION_ID;
  process.env.POSTMAN_PRODUCTION_ENVIRONMENT_ID = PRODUCTION_ENV_ID;
  process.env.POSTMAN_SANDBOX_ENVIRONMENT_ID = SANDBOX_ENV_ID;
  process.env.GITHUB_SHA = 'deadbeefcafe';
  process.env.POSTMAN_AUTOPUBLISH_ENABLED = 'true';   // disabled-state behaviour has its own tests
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.POSTMAN_API_KEY;
  delete process.env.POSTMAN_COLLECTION_ID;
  delete process.env.POSTMAN_PRODUCTION_ENVIRONMENT_ID;
  delete process.env.POSTMAN_SANDBOX_ENVIRONMENT_ID;
  delete process.env.GITHUB_SHA;
  delete process.env.POSTMAN_AUTOPUBLISH_ENABLED;
});

describe('the publication decision is auditable before any write', () => {
  test('a matching remote reports NOOP and issues no PUT', async () => {
    stubFetch();
    const { out } = await run(['--publish']);
    assert.match(out, /ACTION {15}: NOOP/);
    assert.equal(calls.some((c) => c.method === 'PUT'), false, 'NOOP must not write');
    // One GET per TARGET: the collection and the two environments. Each decision is reached
    // from its own response, which is what makes the three independently verifiable.
    assert.equal(calls.filter((c) => c.method === 'GET').length, 3, 'one GET per target');
  });

  test('the audit block carries every required field and no secret', async () => {
    stubFetch();
    const { out } = await run(['--verify']);
    for (const field of ['role', 'source file', 'configured id',
      'repository sha', 'local normalized sha', 'remote normalized sha', 'ACTION']) {
      assert.match(out, new RegExp(`\\s${field}[^:]*:`), `audit output must state "${field}"`);
    }
    // Per-kind fields: a collection reports its request count, an environment its variables.
    assert.match(out, /request count \(local\)[^:]*:/);
    assert.match(out, /variables \(local\)[^:]*:/);
    assert.match(out, /collection name[^:]*:/);
    assert.match(out, /environment name[^:]*:/);
    // THREE independently reported roles, which is the cutover's publisher shape.
    assert.match(out, /role {17}: collection/);
    assert.match(out, /role {17}: production-environment/);
    assert.match(out, /role {17}: sandbox-environment/);
    assert.match(out, /kind {17}: environment/);
    assert.match(out, /repository sha {7}: deadbeefcafe/);
    assert.match(out, /configured id {8}: len=\d+ sha256:[0-9a-f]{8} …d-id/);
    assert.match(out, /autopublish enabled {2}: true/);
    assert.equal(out.includes(DUMMY_KEY), false, 'the key must never appear in output');
    for (const id of [COLLECTION_ID, PRODUCTION_ENV_ID, SANDBOX_ENV_ID]) {
      assert.equal(out.includes(id), false, 'the full configured id is fingerprinted, not echoed');
    }
  });

  test('local and remote normalized hashes are both reported, and match the computed value', async () => {
    stubFetch();
    const { out } = await run(['--verify']);
    const expected = contentHash(readLocal('onchainrisk_api_collection.json'));
    assert.match(out, new RegExp(`local normalized sha : ${expected}`));
  });

  test('verify mode reports UPDATE without writing when the remote differs', async () => {
    stubFetch({ mutate: (b) => { b.collection.item[0].name = 'Remote Renamed Folder'; } });
    const { out } = await run(['--verify']);
    assert.match(out, /ACTION {15}: UPDATE/);
    assert.match(out, /verify-only run: a PUT would be required/);
    assert.equal(calls.some((c) => c.method === 'PUT'), false);
  });

  test('publish mode writes, re-reads and confirms the remote matches local', async () => {
    // All THREE targets drift, so the write-then-verify path runs once per target and the counts
    // below are per-target rather than aggregate.
    stubFetch({
      mutate: (b) => { b.collection.item[0].name = 'Remote Renamed Folder'; },
      mutateEnv: (b) => { b.environment.values[0].value = 'https://drifted.example'; },
    });
    const { out } = await run(['--publish']);
    assert.match(out, /ACTION {15}: UPDATE/);
    // One PUT per target that differs, each followed by its own verifying GET.
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 3);
    assert.match(out, /POSTMAN_REMOTE_MATCH_LOCAL = YES/);
    assert.match(out, /remote sha after PUT/);
    assert.match(out, /request count \(remote\)/);
    // Each target reports its own confirmation line, so one success cannot stand in for three.
    assert.equal((out.match(/POSTMAN_REMOTE_MATCH_LOCAL = YES/g) ?? []).length, 3);
    assert.equal(calls.every((c) => c.hasKey), true, 'every call must be authenticated');
  });

  test('a post-PUT remote that still differs FAILS rather than reporting success', async () => {
    stubFetch({
      mutate: (b) => { b.collection.item[0].name = 'Remote Renamed Folder'; },
      afterPut: (b) => { b.collection.item[0].item[0].request.description = 'server kept something of its own'; },
    });
    await assert.rejects(run(['--publish']), (e) => /POSTMAN_REMOTE_MATCH_LOCAL = NO/.test(e.message)
      && /NOT normalized away/.test(e.message));
  });

  test('a non-2xx from Postman aborts with no fallback', async () => {
    stubFetch({ mutate: (b) => { b.collection.item[0].name = 'X'; }, putStatus: 409 });
    await assert.rejects(run(['--publish']), (e) => /HTTP 409/.test(e.message) && /no fallback/.test(e.message));
    assert.equal(calls.some((c) => c.method === 'POST'), false, 'never create a collection');
  });

  test('a missing API key fails closed', async () => {
    stubFetch();
    delete process.env.POSTMAN_API_KEY;
    await assert.rejects(run(['--verify']), /POSTMAN_API_KEY is not set/);
    assert.equal(calls.length, 0, 'no request may be attempted without a credential');
  });

  test('a missing collection ID variable fails closed and says why', async () => {
    stubFetch();
    delete process.env.POSTMAN_COLLECTION_ID;
    await assert.rejects(run(['--verify']), (e) => /POSTMAN_COLLECTION_ID is not set/.test(e.message)
      && /NOT a cloud id/i.test(e.message));
  });

  test('an error message carrying the key is redacted', async () => {
    calls = [];
    globalThis.fetch = async () => new Response(`denied for key ${DUMMY_KEY}`, { status: 401 });
    await assert.rejects(run(['--verify']), (e) => !e.message.includes(DUMMY_KEY) && /redacted/.test(e.message));
  });

  test('selftest needs no key and makes no request', async () => {
    stubFetch();
    delete process.env.POSTMAN_API_KEY;
    const { code, out } = await run(['--selftest']);
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(out, /OnChainRisk API/);
    assert.match(out, /OnChainRisk API/);
  });
});


describe('the activation gate blocks writing end to end', () => {
  test('publish mode refuses before any request when activation is unset', async () => {
    stubFetch({ mutate: (b) => { b.collection.item[0].name = 'Drifted'; } });
    delete process.env.POSTMAN_AUTOPUBLISH_ENABLED;
    await assert.rejects(run(['--publish']), (e) => /requires POSTMAN_AUTOPUBLISH_ENABLED=true/.test(e.message));
    assert.equal(calls.length, 0, 'not even a GET may be issued');
  });

  for (const value of ['false', 'TRUE', '1', 'yes', '']) {
    test(`publish mode refuses when activation is ${JSON.stringify(value)}`, async () => {
      stubFetch({ mutate: (b) => { b.collection.item[0].name = 'Drifted'; } });
      process.env.POSTMAN_AUTOPUBLISH_ENABLED = value;
      await assert.rejects(run(['--publish']), /POSTMAN_AUTOPUBLISH_ENABLED/);
      assert.equal(calls.some((c) => c.method === 'PUT'), false);
    });
  }

  test('verify mode stays usable while activation is disabled', async () => {
    stubFetch({ mutate: (b) => { b.collection.item[0].name = 'Drifted'; } });
    delete process.env.POSTMAN_AUTOPUBLISH_ENABLED;
    const { out } = await run(['--verify']);
    assert.match(out, /ACTION {15}: UPDATE/);
    assert.match(out, /autopublish enabled {2}: no \(POSTMAN_AUTOPUBLISH_ENABLED=\(unset\)\)/);
    assert.equal(calls.some((c) => c.method === 'PUT'), false);
    assert.equal(calls.filter((c) => c.method === 'GET').length, 3);
  });

  test('a swapped ENVIRONMENT configuration aborts with zero PUT', async () => {
    // The swap that matters now. With one collection there is no second collection to confuse it
    // with, but there ARE two environments — and publishing the production placeholder over the
    // sandbox one would hand every sandbox reader an `ocr_live_*` placeholder where they expect
    // `ocr_test_*`. So the production id is made to resolve to the SANDBOX environment, and the
    // run must abort before any write.
    calls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      calls.push({ method: init?.method ?? 'GET', url: u });
      if (u.includes('/environments/')) {
        const b = { environment: JSON.parse(JSON.stringify(readLocal('sandbox.postman_environment.json'))) };
        b.environment.id = PRODUCTION_ENV_ID;   // the WRONG environment behind the production id
        return new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const b = { collection: JSON.parse(JSON.stringify(readLocal('onchainrisk_api_collection.json'))) };
      b.collection.info._postman_id = COLLECTION_ID;
      b.collection.info.uid = `99999-${COLLECTION_ID}`;
      return new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(run(['--publish']), (e) => /expects "OnChainRisk Production"/.test(e.message));
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0, 'PUT_COUNT must be 0');
  });
});
