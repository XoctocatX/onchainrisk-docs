/*
 * The inventory is a credential-bearing capability that must be incapable of writing. These
 * tests prove that by RUNNING it against a recording fake, not by reading its source — the same
 * distinction that let the #729 auth-surface gate report success while inspecting nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  collectInventory, reportInventory, runInventory, dispositionFor, isRelevant,
  RETIRED_NAMES, DISPOSITIONS, InventoryError,
} from '../postman-inventory.mjs';
import { TARGETS } from '../postman-sync.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../postman-inventory.mjs');
const SRC = readFileSync(SCRIPT, 'utf8');

/*
 * Deliberately NOT `PMAK-` shaped. A realistic-looking Postman key committed as a fixture
 * would trip this repository's own secret-shape scanner in the validate job -- and a scanner
 * that has to tolerate fixtures stops being able to catch the real thing. The assertions only
 * need a distinctive string that must never appear in output.
 */
const SENTINEL = 'SENTINEL-key-must-never-be-logged-0123456789';

/** A fetch that records every call and answers from a fixture. Writes are not possible here. */
function recordingFetch(fixtures = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const path = String(url).replace('https://api.postman.com', '');
    const body = fixtures[path] ?? { collections: [], environments: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  impl.calls = calls;
  return impl;
}

const CLOUD = {
  '/collections': {
    collections: [
      { id: 'c-canonical', uid: 'owner-c-canonical', name: 'OnChainRisk API' },
      { id: 'c-paid', uid: 'owner-c-paid', name: 'OnChainRisk Paid API' },
      { id: 'c-sbx', uid: 'owner-c-sbx', name: 'OnChainRisk Sandbox API' },
      { id: 'c-other', uid: 'owner-c-other', name: 'Some Unrelated Team API' },
    ],
  },
  '/environments': {
    environments: [
      { id: 'e-prod', uid: 'owner-e-prod', name: 'OnChainRisk Production' },
      { id: 'e-sbx', uid: 'owner-e-sbx', name: 'OnChainRisk Sandbox' },
    ],
  },
};

describe('inventory — the request method set is exactly GET', () => {
  test('EXECUTION: every observed call is a GET, with no body', async () => {
    const fetchImpl = recordingFetch(CLOUD);
    await collectInventory({ apiKey: SENTINEL, fetchImpl });

    assert.ok(fetchImpl.calls.length >= 2, 'both listings must be fetched');
    const methods = new Set(fetchImpl.calls.map((c) => c.init.method));
    assert.deepEqual([...methods], ['GET']);
    for (const c of fetchImpl.calls) {
      assert.equal('body' in c.init, false, `${c.url} must carry no body`);
      assert.equal(c.init.headers['x-api-key'], SENTINEL, 'the key must be sent as a header');
    }
  })

  test('both listing endpoints are read, and nothing else is contacted', async () => {
    const fetchImpl = recordingFetch(CLOUD);
    await collectInventory({ apiKey: SENTINEL, fetchImpl });
    const paths = fetchImpl.calls.map((c) => String(c.url).replace('https://api.postman.com', ''));
    assert.deepEqual(paths.sort(), ['/collections', '/environments']);
  })
})

describe('inventory — write verbs are unreachable', () => {
  test('the module contains no write method anywhere', () => {
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const verb of ['PUT', 'POST', 'PATCH', 'DELETE']) {
      assert.equal(new RegExp(`['"\`]${verb}['"\`]`).test(stripped), false,
        `${verb} must not appear as a method literal`);
    }
    // ...and the comments must not be what makes that true: the scan above is on stripped code.
    assert.ok(stripped.includes("method: 'GET'"), 'the GET literal must survive stripping');
  })

  test('the method is a literal, not a parameter — `get()` takes no method argument', () => {
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const sig = stripped.match(/async function get\(([^)]*)\)/);
    assert.ok(sig, '`get` must be the single network primitive');
    assert.equal(/method/i.test(sig[1]), false, '`get` must not accept a method');
    // exactly one fetch call site in the module
    assert.equal((stripped.match(/fetchImpl\(/g) ?? []).length, 1);
  })

  test('nothing writable is imported from the publisher', () => {
    const imports = [...SRC.matchAll(/import \{([^}]+)\} from '\.\/postman-sync\.mjs'/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
    // TARGETS is data; fingerprint and redact are pure string helpers. Nothing that can PUT.
    assert.deepEqual(imports.sort(), ['TARGETS', 'fingerprint', 'redact']);
  })
})

describe('inventory — a missing key fails closed', () => {
  test('no key: it throws BEFORE any network call', async () => {
    const fetchImpl = recordingFetch(CLOUD);
    await assert.rejects(
      () => collectInventory({ apiKey: undefined, fetchImpl }),
      (e) => e instanceof InventoryError && /POSTMAN_API_KEY is not set/.test(e.message),
    );
    assert.deepEqual(fetchImpl.calls, [], 'fail-closed means no request was attempted');
  })

  test('an empty-string key is also refused, not sent', async () => {
    const fetchImpl = recordingFetch(CLOUD);
    await assert.rejects(() => collectInventory({ apiKey: '', fetchImpl }), InventoryError);
    assert.deepEqual(fetchImpl.calls, []);
  })

  test('CLI: a missing key exits 2 and still reports WRITES_ISSUED = 0', () => {
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [SCRIPT],
        { env: { ...process.env, POSTMAN_API_KEY: '' }, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      code = e.status;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    assert.equal(code, 2, 'a run with no key must not exit 0');
    assert.match(out, /POSTMAN_API_KEY is not set/);
    assert.match(out, /WRITES_ISSUED = 0/);
  })

  test('an HTTP error is a failure, not an empty inventory', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
    await assert.rejects(() => collectInventory({ apiKey: SENTINEL, fetchImpl }),
      (e) => e instanceof InventoryError && /HTTP 401/.test(e.message));
  })
})

describe('inventory — the key is never logged', () => {
  test('EXECUTION: the sentinel appears in no line of a full successful run', async () => {
    const lines = [];
    await runInventory({
      env: { POSTMAN_API_KEY: SENTINEL },
      fetchImpl: recordingFetch(CLOUD),
      log: (s) => lines.push(String(s)),
    });
    const all = lines.join('\n');
    assert.ok(all.length > 0, 'the run must actually produce a report');
    assert.equal(all.includes(SENTINEL), false, 'the API key must never be logged');
    // not even a prefix of it
    assert.equal(all.includes(SENTINEL.slice(0, 12)), false);
  })

  /*
   * The test above drives an INJECTED env, so it only catches a leak of the injected value. A
   * mutation that logged `process.env.POSTMAN_API_KEY` passed it — and `process.env` is exactly
   * what the CLI path uses. So run the real CLI, with the real env var, offline: global fetch is
   * replaced in the child before the module loads, so no request leaves the machine.
   */
  test('EXECUTION: the real CLI path never prints the key from process.env', () => {
    const OFFLINE = 'data:text/javascript,'
      + encodeURIComponent('globalThis.fetch = async () => ({ ok: true, status: 200,'
        + ' text: async () => JSON.stringify({ collections: [], environments: [] }) });');
    const out = execFileSync(process.execPath, ['--import', OFFLINE, SCRIPT], {
      env: { ...process.env, POSTMAN_API_KEY: SENTINEL },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.match(out, /WRITES_ISSUED = 0/, 'the offline CLI run must complete');
    assert.equal(out.includes(SENTINEL), false, 'the key must not reach stdout');
    assert.equal(out.includes(SENTINEL.slice(0, 12)), false);
  })

  test('a transport error message is redacted', async () => {
    const fetchImpl = async () => { throw new Error(`socket closed for key ${SENTINEL}`); };
    await assert.rejects(
      () => collectInventory({ apiKey: SENTINEL, fetchImpl }),
      (e) => !e.message.includes(SENTINEL) && /redacted/.test(e.message),
    );
  })

  test('an HTTP error body is redacted', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => `denied: ${SENTINEL}` });
    await assert.rejects(
      () => collectInventory({ apiKey: SENTINEL, fetchImpl }),
      (e) => !e.message.includes(SENTINEL),
    );
  })
})

describe('inventory — dispositions', () => {
  test('one disposition per relevant object, from the declared set', async () => {
    const { rows, outOfScope } = await collectInventory({
      apiKey: SENTINEL, fetchImpl: recordingFetch(CLOUD),
    });
    assert.equal(rows.length, 5, 'four OnChainRisk collections/environments, minus the unrelated one');
    for (const r of rows) assert.ok(DISPOSITIONS.includes(r.disposition), r.disposition);
    assert.deepEqual(outOfScope.map((r) => r.name), ['Some Unrelated Team API']);
  })

  test('canonical names REUSE, retired names KEEP_LEGACY_UNTOUCHED', async () => {
    const { rows } = await collectInventory({ apiKey: SENTINEL, fetchImpl: recordingFetch(CLOUD) });
    const by = (n) => rows.find((r) => r.name === n).disposition;
    assert.equal(by('OnChainRisk API'), 'REUSE_AS_CANONICAL');
    assert.equal(by('OnChainRisk Production'), 'REUSE_AS_CANONICAL');
    assert.equal(by('OnChainRisk Sandbox'), 'REUSE_AS_CANONICAL');
    for (const n of RETIRED_NAMES) assert.equal(by(n), 'KEEP_LEGACY_UNTOUCHED');
  })

  test('"OnChainRisk Sandbox" the ENVIRONMENT is canonical; "… Sandbox API" the COLLECTION is retired', async () => {
    // The two names differ by one word, and confusing them would publish over a retired object.
    const { rows } = await collectInventory({ apiKey: SENTINEL, fetchImpl: recordingFetch(CLOUD) });
    const env = rows.find((r) => r.kind === 'environment' && r.name === 'OnChainRisk Sandbox');
    const col = rows.find((r) => r.kind === 'collection' && r.name === 'OnChainRisk Sandbox API');
    assert.equal(env.disposition, 'REUSE_AS_CANONICAL');
    assert.equal(col.disposition, 'KEEP_LEGACY_UNTOUCHED');
  })

  test('an unknown OnChainRisk object is RENAME_LATER, never silently reused', () => {
    const { disposition } = dispositionFor('OnChainRisk API v2', 'collection', ['OnChainRisk API']);
    assert.equal(disposition, 'RENAME_LATER');
  })

  test('a canonical environment name is not treated as a canonical collection name', () => {
    // Coverage is computed per kind; a name that is canonical for one kind must not satisfy the other.
    const { disposition } = dispositionFor('OnChainRisk Production', 'collection', ['OnChainRisk API']);
    assert.notEqual(disposition, 'REUSE_AS_CANONICAL');
  })

  test('relevance does not depend on casing, and excludes unrelated objects', () => {
    assert.equal(isRelevant('onchainrisk api'), true);
    assert.equal(isRelevant('OCR Internal'), true);
    assert.equal(isRelevant('Stripe Public API'), false);
  })
})

describe('inventory — target coverage', () => {
  test('all three targets covered: one line each, carrying the variable name and id', async () => {
    const { coverage } = await collectInventory({ apiKey: SENTINEL, fetchImpl: recordingFetch(CLOUD) });
    assert.equal(coverage.length, TARGETS.length);
    assert.deepEqual(coverage.map((c) => c.disposition), Array(3).fill('REUSE_AS_CANONICAL'));
    assert.deepEqual(
      coverage.map((c) => [c.idVar, c.id]),
      [
        ['POSTMAN_COLLECTION_ID', 'c-canonical'],
        ['POSTMAN_PRODUCTION_ENVIRONMENT_ID', 'e-prod'],
        ['POSTMAN_SANDBOX_ENVIRONMENT_ID', 'e-sbx'],
      ],
    );
  })

  test('an ABSENT target is CREATE_NEW_REQUIRED, never inferred from what is present', async () => {
    const onlyLegacy = {
      '/collections': { collections: [{ id: 'c-paid', name: 'OnChainRisk Paid API' }] },
      '/environments': { environments: [] },
    };
    const { coverage } = await collectInventory({
      apiKey: SENTINEL, fetchImpl: recordingFetch(onlyLegacy),
    });
    assert.deepEqual(coverage.map((c) => c.disposition), Array(3).fill('CREATE_NEW_REQUIRED'));
    for (const c of coverage) assert.equal(c.id, null);
  })

  test('TWO objects sharing a canonical name is AMBIGUOUS, not a silent pick', async () => {
    const dup = {
      '/collections': {
        collections: [
          { id: 'c-a', name: 'OnChainRisk API' },
          { id: 'c-b', name: 'OnChainRisk API' },
        ],
      },
      '/environments': { environments: [] },
    };
    const { coverage } = await collectInventory({ apiKey: SENTINEL, fetchImpl: recordingFetch(dup) });
    const col = coverage.find((c) => c.kind === 'collection');
    assert.equal(col.disposition, 'AMBIGUOUS_DECIDE');
    assert.equal(col.id, null, 'it must not choose one of the two');
    assert.equal(col.hits.length, 2);
  })

  test('a FORK of the canonical collection is reported as a fork', async () => {
    const forked = {
      '/collections': {
        collections: [{ id: 'c-f', name: 'OnChainRisk API', fork: { label: 'someone' } }],
      },
      '/environments': { environments: [] },
    };
    const { rows } = await collectInventory({ apiKey: SENTINEL, fetchImpl: recordingFetch(forked) });
    assert.equal(rows[0].isFork, true);
    const lines = [];
    reportInventory({ rows, coverage: [], outOfScope: [], writesIssued: 0 }, (s) => lines.push(s));
    assert.match(lines.join('\n'), /\(a FORK\)/);
  })
})

describe('inventory — the report', () => {
  test('it ends with WRITES_ISSUED = 0', async () => {
    const lines = [];
    await runInventory({
      env: { POSTMAN_API_KEY: SENTINEL }, fetchImpl: recordingFetch(CLOUD),
      log: (s) => lines.push(String(s)),
    });
    assert.equal(lines.at(-1), 'WRITES_ISSUED = 0');
  })

  test('writesIssued is reported structurally, so a caller asserts it', async () => {
    const { writesIssued } = await collectInventory({
      apiKey: SENTINEL, fetchImpl: recordingFetch(CLOUD),
    });
    assert.equal(writesIssued, 0);
  })

  test('every object prints name, id and a matchable fingerprint', async () => {
    const lines = [];
    await runInventory({
      env: { POSTMAN_API_KEY: SENTINEL }, fetchImpl: recordingFetch(CLOUD),
      log: (s) => lines.push(String(s)),
    });
    const all = lines.join('\n');
    assert.match(all, /OnChainRisk API/);
    assert.match(all, /c-canonical/);
    // the fingerprint lets an id here be matched to a verify run's `configured id` line
    assert.match(all, /len=11 sha256:[0-9a-f]{8}/);
    assert.match(all, /POSTMAN_COLLECTION_ID = c-canonical/);
  })

  test('an empty relevant inventory says so, rather than printing an empty table', async () => {
    const lines = [];
    await runInventory({
      env: { POSTMAN_API_KEY: SENTINEL },
      fetchImpl: recordingFetch({ '/collections': { collections: [] }, '/environments': { environments: [] } }),
      log: (s) => lines.push(String(s)),
    });
    assert.match(lines.join('\n'), /No OnChainRisk collection or environment is visible/);
  })
})

describe('inventory — workflow wiring', () => {
  const WF = readFileSync(resolve(HERE, '../../workflows/publish-postman.yml'), 'utf8');
  const job = (name) => {
    const start = WF.indexOf(`\n  ${name}:\n`);
    assert.ok(start > -1, `job ${name} must exist`);
    const rest = WF.slice(start + 1);
    const next = rest.search(/\n  [a-z][a-z0-9-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const INVENTORY = job('inventory');
  /*
   * Prohibition assertions below scan CODE, not comments: the job's comment explains that it does
   * not receive POSTMAN_AUTOPUBLISH_ENABLED, and a naive `includes` on the raw block matched that
   * sentence and failed. A prohibition that can be satisfied or broken by prose proves nothing.
   */
  const INVENTORY_CODE = INVENTORY.replace(/^\s*#.*$/gm, '');

  test('`inventory` is a dispatch mode', () => {
    assert.match(WF, /options: \[inventory, verify, publish\]/);
  })

  test('the inventory job runs the maintained repo script', () => {
    assert.match(INVENTORY, /node \.github\/scripts\/postman-inventory\.mjs/);
    // not a copy living outside the repo's maintained scripts
    assert.equal(WF.includes('handoff-artifacts'), false);
  })

  test('it works regardless of POSTMAN_AUTOPUBLISH_ENABLED — the var is not even passed', () => {
    assert.equal(INVENTORY_CODE.includes('POSTMAN_AUTOPUBLISH_ENABLED'), false);
    // and the comment that says so must still be there, unmistakably
    assert.match(INVENTORY, /must work whatever its value is/);
    const cond = INVENTORY.match(/if: (.*)/)[1];
    assert.equal(/AUTOPUBLISH/.test(cond), false, 'the condition must not reference activation');
  })

  test('it receives ONLY the API key — no target ids, nothing else', () => {
    const envBlock = INVENTORY.slice(INVENTORY.indexOf('env:'), INVENTORY.indexOf('run:'));
    const keys = [...envBlock.matchAll(/^\s{10}([A-Z_]+):/gm)].map((m) => m[1]);
    assert.deepEqual(keys, ['POSTMAN_API_KEY']);
    for (const v of ['POSTMAN_COLLECTION_ID', 'POSTMAN_PRODUCTION_ENVIRONMENT_ID',
                     'POSTMAN_SANDBOX_ENVIRONMENT_ID']) {
      assert.equal(INVENTORY_CODE.includes(v), false, `${v} must not be passed to the inventory job`);
    }
  })

  test('it cannot fall through into publication', () => {
    // Each write-capable job demands its own mode, so `inventory` selects none of them.
    assert.match(job('publish'), /inputs\.mode == 'publish'/);
    assert.match(job('verify-only'), /inputs\.mode == 'verify'/);
    assert.equal(/postman-sync\.mjs/.test(INVENTORY_CODE), false,
      'the inventory job must not invoke the publisher at all');
  })

  test('it is dispatch-only, and not restricted to main', () => {
    const cond = INVENTORY.match(/if: (.*)/)[1];
    assert.match(cond, /github\.event_name == 'workflow_dispatch'/);
    // Running before the cutover branch merges is the point: the ids are unknown until then.
    assert.equal(/refs\/heads\/main/.test(cond), false);
    // ...but a push must never select it
    assert.equal(/event_name == 'push'/.test(cond), false);
  })

  test('it still runs behind the validate job and the postman environment gate', () => {
    assert.match(INVENTORY, /needs: validate/);
    assert.match(INVENTORY, /environment: postman/);
  })
})
