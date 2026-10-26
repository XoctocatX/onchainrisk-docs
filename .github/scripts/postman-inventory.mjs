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

import {
  TARGETS, ENVIRONMENTS, fingerprint, redact, readLocal,
  normalizeEnvironmentForCompare, environmentContentHash,
} from './postman-sync.mjs';

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

/* ───────────────── bounded candidate inspection (read-only) ───────────────── */

/*
 * The cutover found two PRE-EXISTING environments and no canonical collection. The question is
 * narrow: can those two cloud objects BECOME the canonical Production/Sandbox targets, keeping
 * their ids, or must new ones be created? Answering it needs their full remote representation,
 * so this inspects EXACTLY the ids it is given — never a listing, never anything adjacent.
 *
 * The decisive rule is not a judgement call, it is already in the publisher:
 * `assertEnvironmentBinding` throws when the REMOTE name differs from the role's expected name.
 * So an environment whose name already matches can be updated in place, and one whose name does
 * not cannot be written to at all until it is renamed out of band — by design, because that is
 * what stops the production placeholder being published over the sandbox environment.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_CANDIDATES = 4;

/** Parse and bound the requested ids. Fails closed: no ids means no inspection, not a pass. */
export function parseCandidateIds(raw) {
  const ids = String(raw ?? '').split(/[\s,]+/).filter(Boolean);
  if (!ids.length) {
    throw new InventoryError(
      'No candidate environment ids were given. Pass the ids to inspect; this does not fall back '
      + 'to listing or guessing, which would inspect objects nobody asked about.',
    );
  }
  const bad = ids.filter((i) => !UUID_RE.test(i));
  if (bad.length) throw new InventoryError(`Not Postman environment ids: ${bad.join(', ')}`);
  // Deduplicate BEFORE the cap: the cap bounds how many OBJECTS are inspected, and a repeated
  // id is one object. Capping first would reject a harmless copy-paste as if it were a wide scan.
  const unique = [...new Set(ids)];
  if (unique.length > MAX_CANDIDATES) {
    throw new InventoryError(`At most ${MAX_CANDIDATES} candidates per run; got ${unique.length}.`);
  }
  return unique;
}

/** The canonical contract each candidate is measured against, read from the reviewed local files. */
export function canonicalEnvContracts() {
  return ENVIRONMENTS.map((t) => {
    const local = normalizeEnvironmentForCompare(readLocal(t.file));
    return {
      role: t.role,
      idVar: t.idVar,
      expectedName: t.expectedName,
      file: t.file,
      keys: local.values.map((v) => v.key),
      hash: environmentContentHash(local),
    };
  });
}

const CREDENTIAL_KEY = 'api_key';
const FORBIDDEN_CREDENTIAL_KEYS = ['paid_api_key', 'sandbox_api_key'];

/**
 * One candidate against one canonical role. Returns the full reuse verdict, including whether the
 * publisher would accept the id as-is.
 */
export function assessCandidate(remoteEnv, contract) {
  const name = remoteEnv?.name ?? null;
  const keys = (remoteEnv?.values ?? []).map((v) => v.key);
  const keySet = new Set(keys);

  const nameMatches = name === contract.expectedName;
  const missing = contract.keys.filter((k) => !keySet.has(k));
  const extra = keys.filter((k) => !contract.keys.includes(k));
  const forbidden = FORBIDDEN_CREDENTIAL_KEYS.filter((k) => keySet.has(k));

  const mutations = [];
  if (!nameMatches) mutations.push(`RENAME "${name}" -> "${contract.expectedName}"`);
  if (missing.length) mutations.push(`ADD ${missing.length} variable(s): ${missing.join(', ')}`);
  if (extra.length) mutations.push(`REMOVE ${extra.length} variable(s): ${extra.join(', ')}`);
  if (!keySet.has(CREDENTIAL_KEY)) mutations.push(`ADD the credential variable \`${CREDENTIAL_KEY}\``);

  /*
   * Reusing the ID is safe whenever the object is genuinely this role's environment: the publisher
   * PUTs `{name, values}` wholesale and keeps the remote id, so a differing variable shape is an
   * ordinary UPDATE, not an obstacle. The one thing that BLOCKS a write is the name assertion.
   */
  return {
    role: contract.role,
    idVar: contract.idVar,
    expectedName: contract.expectedName,
    currentName: name,
    currentKeys: keys,
    currentCount: keys.length,
    expectedCount: contract.keys.length,
    countMatches: keys.length === contract.keys.length,
    keySetIdentical: missing.length === 0 && extra.length === 0,
    missing,
    extra,
    hasCredentialVar: keySet.has(CREDENTIAL_KEY),
    forbiddenCredentialVars: forbidden,
    nameMatches,
    publisherWouldAcceptIdAsIs: nameMatches,
    safeToReuseCloudId: true,
    requiredMutation: mutations.length ? mutations : ['none — already matches the contract'],
  };
}

/** GETs exactly the given environment ids and assesses each against both canonical roles. */
export async function inspectCandidates({ apiKey, fetchImpl, ids }) {
  if (!apiKey) {
    throw new InventoryError(
      'POSTMAN_API_KEY is not set. The candidate inspection needs the repository secret.',
    );
  }
  const wanted = parseCandidateIds(ids);
  const contracts = canonicalEnvContracts();

  const candidates = [];
  for (const id of wanted) {
    const body = await get(`/environments/${id}`, { apiKey, fetchImpl });
    const remote = body?.environment ?? body;
    /*
     * Pair by NAME similarity to a role, never by position: assuming "the first id is production"
     * is how a reviewed id ends up bound to the wrong tier. A candidate is assessed against every
     * role, and the best match is the one whose name already agrees, else the closest by key set.
     */
    const assessments = contracts.map((c) => assessCandidate(remote, c));
    const byName = assessments.find((a) => a.nameMatches);
    const best = byName ?? [...assessments].sort(
      (x, y) => (x.missing.length + x.extra.length) - (y.missing.length + y.extra.length),
    )[0];
    candidates.push({
      requestedId: id,
      remoteId: remote?.id ?? null,
      remoteUid: remote?.uid ?? null,
      idMatchesRequested: !remote?.id || remote.id === id,
      name: remote?.name ?? null,
      assessments,
      best,
    });
  }

  /* Per-role reuse decision, computed from the candidates rather than assumed. */
  const roles = contracts.map((c) => {
    const exact = candidates.filter((k) => k.name === c.expectedName);
    const nearest = candidates.filter((k) => k.best.role === c.role);
    const chosen = exact[0] ?? nearest[0] ?? null;
    return {
      role: c.role,
      idVar: c.idVar,
      expectedName: c.expectedName,
      candidate: chosen,
      reuse: chosen ? 'YES' : 'NO',
      createNew: chosen ? 'NO' : 'YES',
      ambiguous: exact.length > 1,
    };
  });

  return { candidates, contracts, roles, writesIssued: 0 };
}

export function reportCandidates({ candidates, contracts, roles, writesIssued }, log = console.log) {
  log('\nCANDIDATE ENVIRONMENT INSPECTION — read-only, exactly the ids requested\n');
  log(`  canonical contract: ${contracts.map((c) => `${c.expectedName} (${c.keys.length} vars)`).join(' | ')}`);
  log(`  credential variable: ${CREDENTIAL_KEY} — forbidden: ${FORBIDDEN_CREDENTIAL_KEYS.join(', ')}\n`);

  for (const k of candidates) {
    const a = k.best;
    log(`  cloud object            : environment ${k.requestedId}`);
    log(`  remote identity         : id ${k.remoteId ?? '(none)'} / uid ${k.remoteUid ?? '(none returned)'}`);
    if (!k.idMatchesRequested) log('  !! the remote id does not equal the requested id');
    log(`  current name            : ${k.name ?? '(none)'}`);
    log(`  current variable count  : ${a.currentCount} (contract expects ${a.expectedCount})`);
    log(`  current variable keys   : ${a.currentKeys.length ? a.currentKeys.join(', ') : '(none)'}`);
    log(`  canonical role candidate: ${a.role} -> "${a.expectedName}"`);
    log(`  key set identical       : ${a.keySetIdentical ? 'YES' : 'NO'}`);
    if (a.missing.length) log(`    missing vs contract   : ${a.missing.join(', ')}`);
    if (a.extra.length) log(`    extra vs contract     : ${a.extra.join(', ')}`);
    log(`  has \`${CREDENTIAL_KEY}\`          : ${a.hasCredentialVar ? 'YES' : 'NO'}`);
    log(`  forbidden credential var: ${a.forbiddenCredentialVars.length ? a.forbiddenCredentialVars.join(', ') : 'none'}`);
    log(`  safe to reuse cloud id  : ${a.safeToReuseCloudId ? 'YES' : 'NO'}`);
    log(`  publisher accepts as-is : ${a.publisherWouldAcceptIdAsIs ? 'YES' : 'NO — the name assertion blocks the write until renamed'}`);
    log(`  required mutation if reused:`);
    for (const m of a.requiredMutation) log(`    - ${m}`);
    log('');
  }

  log('ROLE DECISIONS\n');
  for (const r of roles) {
    const id = r.candidate ? r.candidate.requestedId : '(none)';
    log(`  ${r.expectedName}`);
    log(`    reuse existing cloud id : ${r.reuse}  ${r.candidate ? `(${id})` : ''}`);
    log(`    requires a NEW object   : ${r.createNew}`);
    log(`    would set               : ${r.idVar} = ${r.candidate ? id : '(unknown — none exists)'}`);
    if (r.ambiguous) log('    !! more than one candidate carries this exact name — DECIDE, do not pick');
    log('');
  }

  log('No environment was created, renamed, updated or deleted.');
  log(`WRITES_ISSUED = ${writesIssued}`);
}

export async function runCandidateInspection({
  env = process.env, fetchImpl = globalThis.fetch, log = console.log,
} = {}) {
  const result = await inspectCandidates({
    apiKey: env.POSTMAN_API_KEY, fetchImpl, ids: env.POSTMAN_CANDIDATE_ENVIRONMENT_IDS,
  });
  reportCandidates(result, log);
  return result;
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
    // One flag, one read-only behaviour. Neither branch can write.
    if (process.argv.includes('--inspect-environments')) await runCandidateInspection();
    else await runInventory();
  } catch (e) {
    // The key is never part of a message, but redact defensively: a transport error can echo a
    // request URL, and a future header change must not be able to leak through an exception.
    console.error(`\nINVENTORY FAILED — ${redact(e.message, process.env.POSTMAN_API_KEY)}`);
    console.error('WRITES_ISSUED = 0');
    process.exit(2);
  }
}
