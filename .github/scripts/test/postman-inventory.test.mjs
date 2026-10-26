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
  parseCandidateIds, canonicalEnvContracts, assessCandidate, inspectCandidates,
  reportCandidates, runCandidateInspection, MAX_CANDIDATES,
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
    // Data and PURE helpers only. Nothing that can PUT: readLocal reads the repo, the two
    // environment helpers normalize/hash in memory. The publisher's writing functions
    // (syncEnvironment, syncCollection) are never imported.
    assert.deepEqual(imports.sort(), [
      'ENVIRONMENTS', 'TARGETS', 'environmentContentHash', 'fingerprint',
      'normalizeEnvironmentForCompare', 'readLocal', 'redact',
    ]);
    for (const writer of ['syncEnvironment', 'syncCollection', 'postman']) {
      assert.equal(imports.includes(writer), false, `${writer} must not be imported`);
    }
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

  test('`inventory` is a dispatch mode, alongside the write mode it must not be confused with', () => {
    const opts = WF.match(/options: \[([^\]]+)\]/)[1].split(',').map((x) => x.trim());
    assert.ok(opts.includes('inventory'));
    assert.ok(opts.includes('publish'), 'publish must remain a SEPARATE, explicit mode');
    // membership, not an exact list: new read-only modes may be added without weakening this
    assert.equal(opts.indexOf('inventory') === opts.indexOf('publish'), false);
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

  test('`inspect-environments` is its own mode, its own job, and cannot write', () => {
    assert.match(WF, /options: \[inventory, inspect-environments, verify, publish\]/);
    const INSPECT = job('inspect-environments');
    const code = INSPECT.replace(/^\s*#.*$/gm, '');
    assert.match(code, /node \.github\/scripts\/postman-inventory\.mjs --inspect-environments/);
    assert.match(code, /inputs\.mode == 'inspect-environments'/);
    // the key and the requested ids, and nothing else: no target ids, no activation variable
    const envBlock = code.slice(code.indexOf('env:'), code.indexOf('run:'));
    const keys = [...envBlock.matchAll(/^\s{10}([A-Z_]+):/gm)].map((m) => m[1]);
    assert.deepEqual(keys, ['POSTMAN_API_KEY', 'POSTMAN_CANDIDATE_ENVIRONMENT_IDS']);
    assert.equal(code.includes('POSTMAN_AUTOPUBLISH_ENABLED'), false);
    assert.equal(code.includes('POSTMAN_PRODUCTION_ENVIRONMENT_ID'), false);
    assert.equal(code.includes('POSTMAN_SANDBOX_ENVIRONMENT_ID'), false);
    assert.equal(/postman-sync\.mjs/.test(code), false);
    assert.match(INSPECT, /needs: validate/);
    assert.match(INSPECT, /environment: postman/);
  })

  test('it still runs behind the validate job and the postman environment gate', () => {
    assert.match(INVENTORY, /needs: validate/);
    assert.match(INVENTORY, /environment: postman/);
  })
})

/* ───────── bounded candidate inspection ───────── */

const PROD_ID = '7dcbd85d-d75d-453a-8c0c-38794ee2caef';
const SBX_ID = '9e130ad9-9644-4b59-bf1e-ed8cb039f01e';

/** A fetch answering GET /environments/{id} from a fixture, recording every call. */
function envFetch(byId) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const id = String(url).split('/environments/')[1];
    if (!byId[id]) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ environment: byId[id] }) };
  };
  impl.calls = calls;
  return impl;
}

const envDoc = (id, name, keys) => ({ id, uid: `999-${id}`, name, values: keys.map((k) => ({ key: k })) });

describe('candidate inspection — bounded input', () => {
  test('no ids fails closed: it must not fall back to a listing', () => {
    assert.throws(() => parseCandidateIds(''), InventoryError);
    assert.throws(() => parseCandidateIds(undefined), /does not fall back to listing/);
  })

  test('non-uuid input is refused, not fetched', async () => {
    const fetchImpl = envFetch({});
    await assert.rejects(
      () => inspectCandidates({ apiKey: 'k', fetchImpl, ids: 'all,collections' }),
      /Not Postman environment ids/,
    );
    assert.deepEqual(fetchImpl.calls, [], 'nothing may be requested for an invalid input');
  })

  test('the batch is capped, and duplicates collapse', () => {
    const many = Array.from({ length: MAX_CANDIDATES + 1 }, () => PROD_ID.replace(/.$/, 'a')).join(',');
    // identical ids collapse to one rather than tripping the cap
    assert.deepEqual(parseCandidateIds(many), [PROD_ID.replace(/.$/, 'a')]);
    const distinct = [
      '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
    ].join(',');
    assert.throws(() => parseCandidateIds(distinct), /At most 4 candidates/);
  })

  test('EXECUTION: only the requested ids are fetched, GET only, no body', async () => {
    const fetchImpl = envFetch({
      [PROD_ID]: envDoc(PROD_ID, 'OnChainRisk Paid', ['base_url']),
      [SBX_ID]: envDoc(SBX_ID, 'OnChainRisk Sandbox', ['base_url']),
    });
    await inspectCandidates({ apiKey: 'k', fetchImpl, ids: `${PROD_ID},${SBX_ID}` });
    const paths = fetchImpl.calls.map((c) => String(c.url).replace('https://api.postman.com', ''));
    assert.deepEqual(paths, [`/environments/${PROD_ID}`, `/environments/${SBX_ID}`]);
    assert.deepEqual([...new Set(fetchImpl.calls.map((c) => c.init.method))], ['GET']);
    for (const c of fetchImpl.calls) assert.equal('body' in c.init, false);
    // no listing endpoint is touched: "do not inspect unrelated objects"
    assert.equal(paths.some((p) => p === '/environments' || p === '/collections'), false);
  })

  test('a 404 on a requested id is a failure, not an empty assessment', async () => {
    await assert.rejects(
      () => inspectCandidates({ apiKey: 'k', fetchImpl: envFetch({}), ids: PROD_ID }),
      /HTTP 404/,
    );
  })
})

describe('candidate inspection — the canonical contract is read from the reviewed files', () => {
  test('both roles expose 15 keys, an api_key, and no tier-named credential', () => {
    const contracts = canonicalEnvContracts();
    assert.equal(contracts.length, 2);
    for (const c of contracts) {
      assert.equal(c.keys.length, 15);
      assert.ok(c.keys.includes('api_key'));
      assert.equal(c.keys.includes('paid_api_key'), false);
      assert.equal(c.keys.includes('sandbox_api_key'), false);
    }
    // the identical-key-set lock, restated here so the inspection cannot drift from it
    const [a, b] = contracts.map((c) => [...c.keys].sort().join(','));
    assert.equal(a, b);
  })
})

describe('candidate inspection — reuse verdicts', () => {
  const contracts = canonicalEnvContracts();
  const prodContract = contracts.find((c) => c.role === 'production-environment');
  const sbxContract = contracts.find((c) => c.role === 'sandbox-environment');

  test('a name mismatch means the publisher REFUSES the id until it is renamed', () => {
    const a = assessCandidate(envDoc(PROD_ID, 'OnChainRisk Paid', ['base_url']), prodContract);
    assert.equal(a.nameMatches, false);
    assert.equal(a.publisherWouldAcceptIdAsIs, false);
    // the id itself is still fine to keep — it is the NAME that blocks the write
    assert.equal(a.safeToReuseCloudId, true);
    assert.ok(a.requiredMutation.some((m) => /^RENAME "OnChainRisk Paid"/.test(m)));
  })

  test('a matching name means it can be updated in place with no rename', () => {
    const a = assessCandidate(envDoc(SBX_ID, 'OnChainRisk Sandbox', ['base_url']), sbxContract);
    assert.equal(a.nameMatches, true);
    assert.equal(a.publisherWouldAcceptIdAsIs, true);
    assert.equal(a.requiredMutation.some((m) => /RENAME/.test(m)), false);
  })

  test('a tier-named credential variable is reported as forbidden, and as an extra to remove', () => {
    const a = assessCandidate(
      envDoc(PROD_ID, 'OnChainRisk Production', ['paid_api_key']), prodContract,
    );
    assert.deepEqual(a.forbiddenCredentialVars, ['paid_api_key']);
    assert.equal(a.hasCredentialVar, false);
    assert.ok(a.extra.includes('paid_api_key'));
    assert.ok(a.missing.includes('api_key'));
  })

  test('an already-conforming environment needs no mutation at all', () => {
    const a = assessCandidate(envDoc(SBX_ID, 'OnChainRisk Sandbox', sbxContract.keys), sbxContract);
    assert.equal(a.keySetIdentical, true);
    assert.equal(a.countMatches, true);
    assert.deepEqual(a.requiredMutation, ['none — already matches the contract']);
  })

  test('the counts are reported against the contract, not assumed to be 15', () => {
    const a = assessCandidate(envDoc(SBX_ID, 'OnChainRisk Sandbox', ['base_url']), sbxContract);
    assert.equal(a.currentCount, 1);
    assert.equal(a.expectedCount, 15);
    assert.equal(a.countMatches, false);
  })
})

describe('candidate inspection — pairing is by name, never by position', () => {
  test('ids given in REVERSE order still pair to the right roles', async () => {
    const byId = {
      [PROD_ID]: envDoc(PROD_ID, 'OnChainRisk Production', ['base_url']),
      [SBX_ID]: envDoc(SBX_ID, 'OnChainRisk Sandbox', ['base_url']),
    };
    // sandbox id FIRST — a positional implementation would bind it to production
    const { roles } = await inspectCandidates({
      apiKey: 'k', fetchImpl: envFetch(byId), ids: `${SBX_ID},${PROD_ID}`,
    });
    const prod = roles.find((r) => r.role === 'production-environment');
    const sbx = roles.find((r) => r.role === 'sandbox-environment');
    assert.equal(prod.candidate.requestedId, PROD_ID);
    assert.equal(sbx.candidate.requestedId, SBX_ID);
  })

  test('two candidates carrying the SAME canonical name is flagged ambiguous', async () => {
    const other = '11111111-2222-4333-8444-555555555555';
    const byId = {
      [SBX_ID]: envDoc(SBX_ID, 'OnChainRisk Sandbox', ['base_url']),
      [other]: envDoc(other, 'OnChainRisk Sandbox', ['base_url']),
    };
    const { roles } = await inspectCandidates({
      apiKey: 'k', fetchImpl: envFetch(byId), ids: `${SBX_ID},${other}`,
    });
    assert.equal(roles.find((r) => r.role === 'sandbox-environment').ambiguous, true);
  })

  test('a role with no candidate at all reports createNew=YES', async () => {
    const byId = { [SBX_ID]: envDoc(SBX_ID, 'OnChainRisk Sandbox', ['base_url']) };
    const { roles } = await inspectCandidates({
      apiKey: 'k', fetchImpl: envFetch(byId), ids: SBX_ID,
    });
    const prod = roles.find((r) => r.role === 'production-environment');
    assert.equal(prod.reuse, 'NO');
    assert.equal(prod.createNew, 'YES');
    assert.equal(prod.candidate, null);
  })
})

describe('candidate inspection — report and safety', () => {
  const byId = {
    [PROD_ID]: envDoc(PROD_ID, 'OnChainRisk Paid', ['base_url', 'paid_api_key']),
    [SBX_ID]: envDoc(SBX_ID, 'OnChainRisk Sandbox', ['base_url', 'sandbox_api_key']),
  };

  test('it ends with WRITES_ISSUED = 0 and names the blocking rule', async () => {
    const lines = [];
    await runCandidateInspection({
      env: { POSTMAN_API_KEY: SENTINEL, POSTMAN_CANDIDATE_ENVIRONMENT_IDS: `${PROD_ID},${SBX_ID}` },
      fetchImpl: envFetch(byId),
      log: (s) => lines.push(String(s)),
    });
    const all = lines.join('\n');
    assert.equal(lines.at(-1), 'WRITES_ISSUED = 0');
    assert.match(all, /the name assertion blocks the write until renamed/);
    assert.match(all, new RegExp(PROD_ID));
    assert.match(all, new RegExp(SBX_ID));
  })

  test('the key never reaches the inspection output', async () => {
    const lines = [];
    await runCandidateInspection({
      env: { POSTMAN_API_KEY: SENTINEL, POSTMAN_CANDIDATE_ENVIRONMENT_IDS: PROD_ID },
      fetchImpl: envFetch(byId),
      log: (s) => lines.push(String(s)),
    });
    assert.equal(lines.join('\n').includes(SENTINEL), false);
  })

  test('variable VALUES are never printed — only keys', async () => {
    const withValues = {
      [SBX_ID]: {
        id: SBX_ID, name: 'OnChainRisk Sandbox',
        values: [{ key: 'api_key', value: 'ocr_test_SHOULD_NOT_BE_PRINTED' }],
      },
    };
    const lines = [];
    await runCandidateInspection({
      env: { POSTMAN_API_KEY: SENTINEL, POSTMAN_CANDIDATE_ENVIRONMENT_IDS: SBX_ID },
      fetchImpl: envFetch(withValues),
      log: (s) => lines.push(String(s)),
    });
    const all = lines.join('\n');
    assert.equal(all.includes('SHOULD_NOT_BE_PRINTED'), false, 'a value may be a real credential');
    assert.match(all, /api_key/, 'but the key must be shown');
  })
})
