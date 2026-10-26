/*
 * POSTMAN CLOUD INVENTORY — a permanent, READ-ONLY operational capability.
 *
 * Answers one question per cloud object: is it a canonical target, a retired object to leave
 * alone, an OnChainRisk object that needs a deliberate decision, or does a target not exist yet?
 * Run it from Actions (`mode: inventory`) so the long-lived key stays in secret storage and
 * nobody has to locate or recreate it. See `.github/POSTMAN_PUBLISHING.md`.
 *
 * WHY IT IS A SEPARATE FILE FROM THE PUBLISHER
 * The publisher can write. This cannot: there is no PUT/POST/PATCH/DELETE in this file, `get()`
 * hard-codes `method: 'GET'` and accepts no method argument, and nothing writable is imported
 * from the publisher — only the TARGETS table and two pure string helpers. "Inventory cannot
 * fall through into publish logic" is therefore a property of the module graph, not of a flag.
 *
 * WHY `fetchImpl` IS INJECTABLE
 * So the safety claims are proven by EXECUTION rather than by reading the source. The tests
 * drive a recording fake and assert the observed method set is exactly {GET}, that no request
 * carried a body, and that the key never reaches a log line. A source scan alone would be the
 * same mistake that let the #729 gate report success while inspecting nothing.
 *
 * ON PRINTING IDS
 * The publisher deliberately FINGERPRINTS a configured id rather than echoing it: there, the id
 * is an input being audited. Here the id is the OUTPUT — discovering it is the entire purpose,
 * and it is what becomes a repository variable. A Postman object id is not a credential (it
 * appears in share URLs). Each is printed in full AND fingerprinted, so an id found here can be
 * matched against the `configured id` line of a later verify run. The API KEY is never printed,
 * never fingerprinted, and never interpolated into any message.
 */

import { TARGETS, fingerprint, redact } from './postman-sync.mjs';

const POSTMAN_API = 'https://api.postman.com';

/** The names this cutover retired. Present-but-legacy is an expected, acceptable outcome. */
export const RETIRED_NAMES = ['OnChainRisk Paid API', 'OnChainRisk Sandbox API'];

/** Objects worth a disposition at all: ours, or plausibly ours. */
const RELEVANT = /onchainrisk|\bocr\b/i;

export const DISPOSITIONS = [
  'REUSE_AS_CANONICAL', 'KEEP_LEGACY_UNTOUCHED', 'RENAME_LATER', 'CREATE_NEW_REQUIRED',
];

export class InventoryError extends Error {}

/**
 * The ONLY network primitive in this module. The method is a literal, not a parameter, so no
 * caller — present or future — can turn this into a write.
 */
async function get(path, { apiKey, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${POSTMAN_API}${path}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    });
  } catch (e) {
    throw new InventoryError(`GET ${path} failed at the transport layer: ${redact(e.message, apiKey)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new InventoryError(`GET ${path} -> HTTP ${res.status}. ${redact(text, apiKey).slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InventoryError(`GET ${path} returned a 2xx that is not JSON`);
  }
}

/** Disposition for one cloud object, given the canonical names for its kind. */
export function dispositionFor(name, kind, canonicalNames) {
  if (canonicalNames.includes(name)) {
    return { disposition: 'REUSE_AS_CANONICAL', why: `already named exactly "${name}"` };
  }
  if (RETIRED_NAMES.includes(name)) {
    return {
      disposition: 'KEEP_LEGACY_UNTOUCHED',
      why: 'retired per-tier object — do not publish to it, do not delete it',
    };
  }
  return {
    disposition: 'RENAME_LATER',
    why: `an OnChainRisk ${kind} that is neither canonical nor a known retired name`,
  };
}

export const isRelevant = (name) => RELEVANT.test(String(name ?? ''))
  || RETIRED_NAMES.includes(name)
  || TARGETS.some((t) => t.expectedName === name);

/**
 * @returns {Promise<{rows, coverage, outOfScope, writesIssued}>} `writesIssued` is structurally
 *   always 0 — it is reported so the caller asserts it rather than assuming it.
 */
export async function collectInventory({ apiKey, fetchImpl }) {
  if (!apiKey) {
    // FAIL CLOSED, before any network call: a run with no key must not look like a clean result.
    throw new InventoryError(
      'POSTMAN_API_KEY is not set. The inventory needs the repository secret; it does not fall '
      + 'back to an unauthenticated listing, which would report an empty cloud as "nothing exists".',
    );
  }

  const canonicalBy = {
    collection: TARGETS.filter((t) => t.kind === 'collection').map((t) => t.expectedName),
    environment: TARGETS.filter((t) => t.kind === 'environment').map((t) => t.expectedName),
  };

  const rows = [];
  const outOfScope = [];

  const { collections = [] } = await get('/collections', { apiKey, fetchImpl });
  for (const c of collections) {
    const row = { kind: 'collection', name: c.name, id: c.id, uid: c.uid, isFork: !!c.fork };
    if (!isRelevant(c.name)) { outOfScope.push(row); continue; }
    rows.push({ ...row, ...dispositionFor(c.name, 'collection', canonicalBy.collection) });
  }

  const { environments = [] } = await get('/environments', { apiKey, fetchImpl });
  for (const e of environments) {
    const row = { kind: 'environment', name: e.name, id: e.id, uid: e.uid, isFork: false };
    if (!isRelevant(e.name)) { outOfScope.push(row); continue; }
    rows.push({ ...row, ...dispositionFor(e.name, 'environment', canonicalBy.environment) });
  }

  /*
   * Coverage is computed per TARGET, not per cloud object, because the question "does the
   * canonical collection exist" cannot be answered by looking at what IS there. An absent target
   * is reported as CREATE_NEW_REQUIRED; two objects sharing a canonical name is an ambiguity a
   * human resolves, never something this picks a winner for.
   */
  const coverage = TARGETS.map((t) => {
    const hits = rows.filter((r) => r.kind === t.kind && r.name === t.expectedName);
    if (hits.length === 1) {
      return { ...t, disposition: 'REUSE_AS_CANONICAL', id: hits[0].id, uid: hits[0].uid };
    }
    if (hits.length === 0) return { ...t, disposition: 'CREATE_NEW_REQUIRED', id: null, hits: [] };
    return { ...t, disposition: 'AMBIGUOUS_DECIDE', id: null, hits };
  });

  return { rows, coverage, outOfScope, writesIssued: 0 };
}

const pad = (s, n) => String(s ?? '').padEnd(n);

export function reportInventory({ rows, coverage, outOfScope, writesIssued }, log = console.log) {
  log('\nPOSTMAN CLOUD INVENTORY — read-only\n');

  if (!rows.length) {
    log('  No OnChainRisk collection or environment is visible to this key.');
  } else {
    log(`  ${pad('KIND', 12)}${pad('NAME', 26)}${pad('DISPOSITION', 24)}ID`);
    log(`  ${'-'.repeat(12)}${'-'.repeat(26)}${'-'.repeat(24)}${'-'.repeat(38)}`);
    for (const r of rows) {
      log(`  ${pad(r.kind, 12)}${pad(r.name, 26)}${pad(r.disposition, 24)}${r.id}`);
      log(`  ${' '.repeat(12)}${pad(r.isFork ? '(a FORK)' : '', 26)}${pad('', 24)}${fingerprint(r.id)}`);
    }
  }

  log('\nTARGET COVERAGE — one line per target this repository publishes\n');
  for (const c of coverage) {
    if (c.disposition === 'REUSE_AS_CANONICAL') {
      log(`  REUSE_AS_CANONICAL   ${pad(c.expectedName, 26)} ${c.idVar} = ${c.id}`);
    } else if (c.disposition === 'CREATE_NEW_REQUIRED') {
      log(`  CREATE_NEW_REQUIRED  ${pad(c.expectedName, 26)} no cloud ${c.kind} carries this exact name`);
    } else {
      log(`  AMBIGUOUS — DECIDE   ${pad(c.expectedName, 26)} ${c.hits.length} objects share this name:`);
      for (const h of c.hits) log(`  ${' '.repeat(21)}${pad('', 26)} id=${h.id}`);
    }
  }

  if (outOfScope.length) {
    log(`\nNOT RELEVANT TO THIS CONTRACT — ${outOfScope.length} other object(s) visible to this key.`);
    log('No disposition is offered for these; they are not part of the published package.');
    for (const r of outOfScope) log(`  ${pad(r.kind, 12)}${r.name}`);
  }

  for (const r of rows) log(`\n  note  ${r.kind}/${r.name}: ${r.why}`);

  log('\nNothing was created, renamed, deleted or written.');
  log(`WRITES_ISSUED = ${writesIssued}`);
}

export async function runInventory({
  env = process.env, fetchImpl = globalThis.fetch, log = console.log,
} = {}) {
  const result = await collectInventory({ apiKey: env.POSTMAN_API_KEY, fetchImpl });
  reportInventory(result, log);
  return result;
}

const isMain = process.argv[1]
  && process.argv[1].endsWith('postman-inventory.mjs');
if (isMain) {
  try {
    await runInventory();
  } catch (e) {
    // The key is never part of a message, but redact defensively: a transport error can echo a
    // request URL, and a future header change must not be able to leak through an exception.
    console.error(`\nINVENTORY FAILED — ${redact(e.message, process.env.POSTMAN_API_KEY)}`);
    console.error('WRITES_ISSUED = 0');
    process.exit(2);
  }
}
