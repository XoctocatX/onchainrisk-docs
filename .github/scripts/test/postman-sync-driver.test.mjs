/**
 * Drives main() with a stubbed fetch, so the publication DECISION and its audit output are
 * tested without a network call, without an API key and without mutating anything.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { main, readLocal, contentHash } from '../postman-sync.mjs';

const realFetch = globalThis.fetch;
const DUMMY_KEY = 'not-a-key-stubbed-transport';
let calls;

/** Serve each collection back as its own remote, optionally mutated. */
function stubFetch({ mutate = null, putStatus = 200, afterPut = null } = {}) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), hasKey: Boolean(init?.headers?.['x-api-key']) });
    const paid = String(url).includes('paid-cloud-id');
    const local = readLocal(paid ? 'paid-collection.json' : 'onchainrisk_sandbox_api_collection.json');
    if (method === 'PUT') {
      return new Response(JSON.stringify({ collection: { uid: 'x' } }), { status: putStatus, headers: { 'Content-Type': 'application/json' } });
    }
    const alreadyPut = calls.some((c) => c.method === 'PUT' && c.url === String(url));
    const body = { collection: JSON.parse(JSON.stringify(local)) };
    body.collection.info._postman_id = paid ? 'paid-cloud-id' : 'sandbox-cloud-id';
    body.collection.info.uid = `99999-${paid ? 'paid-cloud-id' : 'sandbox-cloud-id'}`;
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
  process.env.POSTMAN_PAID_COLLECTION_ID = 'paid-cloud-id';
  process.env.POSTMAN_SANDBOX_COLLECTION_ID = 'sandbox-cloud-id';
  process.env.GITHUB_SHA = 'deadbeefcafe';
  process.env.POSTMAN_AUTOPUBLISH_ENABLED = 'true';   // disabled-state behaviour has its own tests
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.POSTMAN_API_KEY;
  delete process.env.POSTMAN_PAID_COLLECTION_ID;
  delete process.env.POSTMAN_SANDBOX_COLLECTION_ID;
  delete process.env.GITHUB_SHA;
  delete process.env.POSTMAN_AUTOPUBLISH_ENABLED;
});

describe('the publication decision is auditable before any write', () => {
  test('a matching remote reports NOOP and issues no PUT', async () => {
    stubFetch();
    const { out } = await run(['--publish']);
    assert.match(out, /ACTION {15}: NOOP/);
    assert.equal(calls.some((c) => c.method === 'PUT'), false, 'NOOP must not write');
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2, 'one GET per collection');
  });

  test('the audit block carries every required field and no secret', async () => {
    stubFetch();
    const { out } = await run(['--verify']);
    for (const field of ['role', 'source file', 'collection name', 'configured id',
      'repository sha', 'local normalized sha', 'remote normalized sha',
      'request count \\(local\\)', 'ACTION']) {
      assert.match(out, new RegExp(`\\s${field}[^:]*:`), `audit output must state "${field}"`);
    }
    assert.match(out, /role {17}: paid/);
    assert.match(out, /role {17}: sandbox/);
    assert.match(out, /repository sha {7}: deadbeefcafe/);
    assert.match(out, /configured id {8}: len=13 sha256:[0-9a-f]{8} …d-id/);
    assert.match(out, /autopublish enabled {2}: true/);
    assert.equal(out.includes(DUMMY_KEY), false, 'the key must never appear in output');
    assert.equal(out.includes('paid-cloud-id'), false, 'the full configured id is fingerprinted, not echoed');
  });

  test('local and remote normalized hashes are both reported, and match the computed value', async () => {
    stubFetch();
    const { out } = await run(['--verify']);
    const expected = contentHash(readLocal('paid-collection.json'));
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
    stubFetch({ mutate: (b) => { b.collection.item[0].name = 'Remote Renamed Folder'; } });
    const { out } = await run(['--publish']);
    assert.match(out, /ACTION {15}: UPDATE/);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);
    assert.match(out, /POSTMAN_REMOTE_MATCH_LOCAL = YES/);
    assert.match(out, /remote sha after PUT/);
    assert.match(out, /request count \(remote\)/);
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
    delete process.env.POSTMAN_PAID_COLLECTION_ID;
    await assert.rejects(run(['--verify']), (e) => /POSTMAN_PAID_COLLECTION_ID is not set/.test(e.message)
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
    assert.match(out, /OnChainRisk Paid API/);
    assert.match(out, /OnChainRisk Sandbox API/);
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
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2);
  });

  test('a swapped configuration aborts with zero PUT', async () => {
    // paid variable resolving to the sandbox collection
    calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      const l = readLocal('onchainrisk_sandbox_api_collection.json');   // wrong collection for this role
      const b = { collection: JSON.parse(JSON.stringify(l)) };
      b.collection.info._postman_id = 'paid-cloud-id';
      return new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(run(['--publish']), (e) => /may only update "OnChainRisk Paid API"/.test(e.message));
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0, 'PUT_COUNT must be 0');
  });
});
