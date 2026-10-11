#!/usr/bin/env node
/**
 * Publish this repository's reviewed Postman collections to Postman cloud.
 *
 * AUTHORITY. The checked-in JSON is the only content authority. It arrives here by mirror sync
 * from XoctocatX/onchainrisk, which already gates OpenAPI <-> Postman conformance, so this
 * script never regenerates a collection from OpenAPI and never treats the remote as truth:
 *
 *     CORE canonical -> production served artifacts -> this mirror -> Postman cloud
 *
 * The remote collection is fetched for exactly three reasons: to confirm the configured id is
 * the intended target, to decide whether a write is needed at all, and to recover
 * Postman-managed identities so an unchanged entity keeps the id Postman assigned it.
 *
 * SAFETY. Every failure mode fails closed — a missing credential, a missing or WRONG collection
 * id, a target whose name is not the expected one, an ambiguous identity, any non-2xx, or a
 * post-write comparison that still differs from the local file. There is no
 * create-new-collection fallback, no name-based discovery and no configuration repair.
 *
 * R1: two defects this version fixes.
 *   1. A configured id merely had to resolve. Swapping the two variables would therefore have
 *      overwritten the wrong collection with the other one's content. The role is now bound to
 *      the target by hard-coded collection name plus an id/uid consistency check.
 *   2. The managed-identity model covered item and response `id` only. Postman also returns
 *      `uid` on items and responses and an `id` on event scripts, and omitting an existing id
 *      makes Postman delete and recreate that entity. Managed identity is now modelled
 *      structurally at every position Postman owns — and only there, so an `id` inside a request
 *      body stays our content.
 *
 * Standard library only; no dependencies, no package manager.
 *
 *   node .github/scripts/postman-sync.mjs --selftest   parse local files, no network, no key
 *   node .github/scripts/postman-sync.mjs --verify      read-only: report NOOP/UPDATE
 *   node .github/scripts/postman-sync.mjs --publish     write when needed, then verify
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const POSTMAN_API = 'https://api.postman.com';

/** The repository variable that must be exactly 'true' before anything can be written. */
export const ACTIVATION_VAR = 'POSTMAN_AUTOPUBLISH_ENABLED';

/**
 * The two collections this repository publishes, and the name each target MUST have.
 *
 * `expectedName` is a SAFETY ASSERTION, never a lookup: the script will not search Postman for a
 * collection with this name, and will not switch to a different id if the configured one points
 * somewhere else. It exists so that a swapped or mistyped variable fails instead of overwriting
 * an unintended collection.
 */
export const COLLECTIONS = [
  {
    role: 'paid',
    file: 'paid-collection.json',
    idVar: 'POSTMAN_PAID_COLLECTION_ID',
    expectedName: 'OnChainRisk Paid API',
  },
  {
    role: 'sandbox',
    file: 'onchainrisk_sandbox_api_collection.json',
    idVar: 'POSTMAN_SANDBOX_COLLECTION_ID',
    expectedName: 'OnChainRisk Sandbox API',
  },
];

/**
 * POSTMAN-MANAGED IDENTITY, modelled by POSITION rather than by key name.
 *
 * Only these exact positions are normalized for comparison and repopulated from the remote.
 * A recursive "delete anything called id" would also erase an `id` inside a request body or a
 * response example, which is our content and must participate in the comparison.
 */
/*
 * `_postman_id` vs `postman_id`: the Postman API uses BOTH spellings depending on the position
 * and the endpoint — the collection export carries `info._postman_id`, while the PUT
 * documentation also refers to managed `id`, `uid` and `postman_id` values on structural
 * entities. Both spellings are therefore listed at every managed position, deliberately and by
 * position. They are NOT stripped by name anywhere else: a content object that happens to carry
 * `"postman_id": "business-data"` keeps it, and that value participates in the content hash.
 */
const MANAGED = {
  // The export carries `info._postman_id`; the PUT documentation also cites `postman_id`; `uid`,
  // `owner`, `fork` and the timestamps are server metadata present on API responses.
  collectionInfo: ['_postman_id', 'postman_id', 'uid', 'owner', 'fork', 'createdAt', 'updatedAt', 'lastUpdatedBy', 'lastRevision'],
  collectionTop: ['_postman_exported_at', '_postman_exported_using'],
  // v2.1 documents `id` on items; the API returns `uid` on items; PUT cites `postman_id`.
  item: ['id', 'uid', '_postman_id', 'postman_id'],
  // A response example likewise comes back with both `id` and `uid`.
  response: ['id', 'uid', '_postman_id', 'postman_id'],
  // R3 position-aware review: v2.1 documents `id` on event and script objects and the PUT
  // documentation cites `postman_id`, but neither the schema nor any response we model carries a
  // `uid` at these positions, so the speculative `uid` added in R2 is removed. Erring this way is
  // the safe direction — an unmodelled managed field surfaces as loud drift and a failed run,
  // whereas normalizing a field Postman does not own there would silently hide content changes.
  event: ['id', '_postman_id', 'postman_id'],
  eventScript: ['id', '_postman_id', 'postman_id'],
};

/** Info-level identity representations that may be restored into a PUT payload. */
const INFO_IDENTITY_KEYS = ['_postman_id', 'postman_id', 'uid'];

/** Reserved identity-map key for the collection root (its own event/script identities). */
export const COLLECTION_ROOT_KEY = 'collection:root';

export class SyncError extends Error {}

/** Strip a secret from any text before it can reach a log, a message or an exit code. */
export function redact(text, secret) {
  const s = String(text ?? '');
  if (!secret) return s;
  return s.split(secret).join('***redacted***');
}

/** A short, non-reversible fingerprint so a configured id is auditable without being echoed. */
export function fingerprint(value) {
  const v = String(value ?? '');
  if (!v) return '(unset)';
  return `len=${v.length} sha256:${createHash('sha256').update(v).digest('hex').slice(0, 8)} …${v.slice(-4)}`;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
const unwrap = (c) => c?.collection ?? c;

/** Visit every Postman-managed position in a collection: { holder, keys, kind, path }. */
function* managedPositions(collection) {
  const c = collection;
  yield { holder: c, keys: MANAGED.collectionTop, kind: 'collection', path: '' };
  if (isObj(c.info)) yield { holder: c.info, keys: MANAGED.collectionInfo, kind: 'info', path: 'info' };
  // Collection v2.1 allows ROOT-level events — collection-wide prerequest/test scripts — and the
  // API returns managed ids on them exactly as it does on an item's events. Missing these was
  // what would have produced false drift, script-id churn and a post-PUT mismatch the first time
  // a collection-wide script appeared.
  for (const [j, e] of (c.event ?? []).entries()) {
    if (!isObj(e)) continue;
    yield { holder: e, keys: MANAGED.event, kind: 'collectionEvent', path: `event[${j}]` };
    if (isObj(e.script)) yield { holder: e.script, keys: MANAGED.eventScript, kind: 'collectionEventScript', path: `event[${j}].script` };
  }
  const walk = (nodes, path) => {
    for (const [i, n] of (nodes ?? []).entries()) {
      if (!isObj(n)) continue;
      const here = `${path}item[${i}]`;
      positions.push({ holder: n, keys: MANAGED.item, kind: 'item', path: here });
      for (const [j, r] of (n.response ?? []).entries()) {
        if (isObj(r)) positions.push({ holder: r, keys: MANAGED.response, kind: 'response', path: `${here}.response[${j}]` });
      }
      for (const [j, e] of (n.event ?? []).entries()) {
        if (!isObj(e)) continue;
        positions.push({ holder: e, keys: MANAGED.event, kind: 'event', path: `${here}.event[${j}]` });
        if (isObj(e.script)) positions.push({ holder: e.script, keys: MANAGED.eventScript, kind: 'eventScript', path: `${here}.event[${j}].script` });
      }
      if (Array.isArray(n.item)) walk(n.item, `${here}.`);
    }
  };
  const positions = [];
  if (Array.isArray(c.item)) walk(c.item, '');
  yield* positions;
}

/** Remove every Postman-managed identity, leaving only our content. */
export function stripManaged(collection) {
  const c = clone(unwrap(collection));
  for (const { holder, keys } of managedPositions(c)) for (const k of keys) delete holder[k];
  return c;
}

/** The comparable content of a collection: ours, with Postman's identity removed. */
export const normalizeForCompare = (collection) => stripManaged(collection);

/** Stable, key-order-independent hash of the comparable content. */
export function contentHash(collection) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (!isObj(v)) return v;
    return Object.keys(v).sort().reduce((a, k) => { a[k] = sortKeys(v[k]); return a; }, {});
  };
  return createHash('sha256').update(JSON.stringify(sortKeys(normalizeForCompare(collection)))).digest('hex');
}

export const semanticallyEqual = (a, b) => contentHash(a) === contentHash(b);

/** The request path as an identity component: no host, no query, variables collapsed. */
export function normalizePath(url) {
  const raw = typeof url === 'string' ? url : String(url?.raw ?? '');
  return raw
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\{\{[^}]+\}\}/, '')
    .replace(/\?.*$/, '')
    .replace(/\{\{[^}]+\}\}/g, '{var}')
    .replace(/\/+$/, '');
}

export const folderKey = (ancestry) => `folder:${ancestry.join(' / ')}`;
export const requestKey = (ancestry, method, url) =>
  `request:${ancestry.join(' / ')}|${String(method ?? '').toUpperCase()}|${normalizePath(url)}`;

const pickManaged = (holder, keys) => {
  const out = {};
  for (const k of keys) if (holder[k] !== undefined) out[k] = holder[k];
  return Object.keys(out).length ? out : null;
};

/**
 * Map every entity in a collection to the Postman identity it carries, keyed by stable identity.
 * Throws on a duplicated item identity: an ambiguous map cannot place ids safely.
 *
 * Sub-entities (response examples, event scripts) are keyed within their item — by example name
 * and by `listen` respectively. A duplicate there is NOT fatal: the id is deliberately omitted,
 * so Postman recreates that sub-entity rather than having an id guessed for it.
 */
export function buildIdentityMap(collection, { label = 'collection' } = {}) {
  const c = unwrap(collection);
  const map = new Map();
  const seen = new Map();
  const walk = (nodes, ancestry) => {
    for (const n of nodes ?? []) {
      if (!isObj(n)) continue;
      const name = String(n.name ?? '');
      const here = [...ancestry, name];
      const key = Array.isArray(n.item) ? folderKey(here) : requestKey(ancestry, n.request?.method, n.request?.url);
      if (seen.has(key)) {
        throw new SyncError(
          `${label}: ambiguous identity ${key} — "${seen.get(key)}" and "${name}" resolve to the same `
          + `stable identity, so a Postman id cannot be assigned unambiguously. Give them distinct `
          + `names, methods or paths and re-run.`,
        );
      }
      seen.set(key, name);
      map.set(key, {
        item: pickManaged(n, MANAGED.item),
        responses: subMap(n.response, (r) => String(r.name ?? ''), MANAGED.response),
        events: subMap(n.event, (e) => String(e.listen ?? ''), MANAGED.event),
        scripts: subMap(n.event, (e) => String(e.listen ?? ''), MANAGED.eventScript, (e) => e.script),
      });
      if (Array.isArray(n.item)) walk(n.item, here);
    }
  };
  walk(c.item, []);
  // The collection root's own events, matched by `listen` like any other event list. A duplicate
  // `listen` drops that entry, so the id is omitted rather than guessed.
  map.set(COLLECTION_ROOT_KEY, {
    events: subMap(c.event, (e) => String(e.listen ?? ''), MANAGED.event),
    scripts: subMap(c.event, (e) => String(e.listen ?? ''), MANAGED.eventScript, (e) => e.script),
  });
  return map;
}

/**
 * Structural keys that occur EXACTLY ONCE in a sub-entity list.
 *
 * R3: multiplicity is computed over the whole list before any identity is looked at. The
 * previous implementation only noticed a duplicate when an EARLIER occurrence had already
 * inserted an id, so this remote shape was accepted as unambiguous:
 *
 *     [ { listen: 'test', script: {...} },                     // no managed id
 *       { listen: 'test', id: 'event-2', script: { id: 'script-2' } } ]
 *
 * The first occurrence contributed nothing, so the second looked like the only one and its ids
 * were retained — guessing identity across an ambiguous key. It was order-dependent too: the
 * reverse order correctly refused. Presence of an id, presence of a script, and list order are
 * now all irrelevant to the ambiguity decision.
 *
 * One shared implementation serves response names, item-event `listen` and root-event `listen`,
 * on both the remote and the local side.
 */
export function unambiguousKeys(list, keyOf) {
  const counts = new Map();
  for (const entry of list ?? []) {
    if (!isObj(entry)) continue;
    const k = keyOf(entry);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, n]) => n === 1).map(([k]) => k));
}

/**
 * Managed ids of sub-entities, keyed by a structural name. A key occurring more than once in the
 * list yields NO mapping at all — decided first, by unambiguousKeys above.
 */
function subMap(list, keyOf, keys, pick = (x) => x) {
  const out = new Map();
  const allowed = unambiguousKeys(list, keyOf);
  for (const entry of list ?? []) {
    if (!isObj(entry)) continue;
    const k = keyOf(entry);
    if (!allowed.has(k)) continue;              // ambiguous structural key: never mapped
    const target = pick(entry);
    if (!isObj(target)) continue;
    const managed = pickManaged(target, keys);
    if (managed) out.set(k, managed);
  }
  return out;
}

/**
 * The outbound payload: LOCAL content, every local managed id stripped first, then the remote's
 * managed identities injected where the identity matches unambiguously.
 *
 * Stripping first is what stops a stale id in a checked-in file from leaking into a full
 * replacement. No remote CONTENT is ever copied — not a description, script body, variable,
 * auth value, header or example body.
 */
export function injectRemoteIds(local, remoteIdMap, { remoteInfoIdentity = null } = {}) {
  const out = stripManaged(local);          // clean slate: no local managed ids survive
  const assign = (holder, managed) => { if (managed) for (const [k, v] of Object.entries(managed)) holder[k] = v; };

  /**
   * Ambiguity is checked on BOTH sides, with the same shared helper. The remote map already
   * refuses a duplicated key; without this the single remote id for `listen: "test"` would be
   * written onto TWO local events that both declare it — the same managed id on two entities,
   * which is never valid.
   */
  const unambiguous = unambiguousKeys;
  const byName = (x) => String(x.name ?? '');
  const byListen = (x) => String(x.listen ?? '');
  const walk = (nodes, ancestry) => {
    for (const n of nodes ?? []) {
      if (!isObj(n)) continue;
      const here = [...ancestry, String(n.name ?? '')];
      const key = Array.isArray(n.item) ? folderKey(here) : requestKey(ancestry, n.request?.method, n.request?.url);
      const hit = remoteIdMap.get(key);
      if (hit) {
        assign(n, hit.item);
        const okResponses = unambiguous(n.response, byName);
        for (const r of n.response ?? []) {
          if (isObj(r) && okResponses.has(byName(r))) assign(r, hit.responses?.get(byName(r)));
        }
        const okEvents = unambiguous(n.event, byListen);
        for (const e of n.event ?? []) {
          if (!isObj(e) || !okEvents.has(byListen(e))) continue;
          assign(e, hit.events?.get(byListen(e)));
          if (isObj(e.script)) assign(e.script, hit.scripts?.get(byListen(e)));
        }
      }
      if (Array.isArray(n.item)) walk(n.item, here);
    }
  };
  walk(out.item, []);
  // Root-level events, same rules: ids only, matched by `listen`, nothing guessed.
  const root = remoteIdMap.get(COLLECTION_ROOT_KEY);
  if (root) {
    const okRoot = unambiguous(out.event, byListen);
    for (const e of out.event ?? []) {
      if (!isObj(e) || !okRoot.has(byListen(e))) continue;
      assign(e, root.events?.get(byListen(e)));
      if (isObj(e.script)) assign(e.script, root.scripts?.get(byListen(e)));
    }
  }
  // The PUT schema addresses the collection by its own managed identity. Use the identity the
  // REMOTE returned — not the configured variable, which may be an id or a uid representation.
  if (remoteInfoIdentity && isObj(out.info)) Object.assign(out.info, remoteInfoIdentity);
  return out;
}

/**
 * Is the configured variable consistent with the identity the remote returned?
 *
 * Postman addresses a collection by `id` or by `uid`, where a uid is `{ownerId}-{id}`.
 *
 * R2 hardening: when the remote supplies BOTH representations, only an exact match against one
 * of them is accepted. The earlier rule also accepted any string ending in `-${id}`, which would
 * have admitted a uid carrying someone else's owner prefix. When only one representation is
 * returned, the other is derived ONLY where its syntax is provable from what was returned: a uid
 * yields its bare id by dropping the owner prefix, but an id alone yields nothing, because the
 * owner prefix cannot be invented. This is hardening, not a discovery mechanism.
 */
export function identityConsistent(configured, { id, uid } = {}) {
  const v = String(configured ?? '');
  if (!v) return false;
  const rid = id ? String(id) : null;
  const ruid = uid ? String(uid) : null;

  if (rid && ruid) return v === rid || v === ruid;      // both known: exact match only
  if (rid) return v === rid;                            // an owner prefix cannot be inferred
  if (ruid) {
    if (v === ruid) return true;
    const sep = ruid.indexOf('-');
    const derivedId = sep > 0 ? ruid.slice(sep + 1) : null;   // provable: strip the owner prefix
    return Boolean(derivedId) && v === derivedId;
  }
  return false;
}

/**
 * Bind a role to its remote target. Any failure here aborts before a write is contemplated.
 * The name is asserted, never searched for.
 */
export function assertTargetBinding({ entry, local, remote, configuredId }) {
  const localName = String(unwrap(local)?.info?.name ?? '');
  if (localName !== entry.expectedName) {
    throw new SyncError(
      `${entry.role}: ${entry.file} is named "${localName}" but this role publishes `
      + `"${entry.expectedName}". Refusing to publish a file that is not the expected collection.`,
    );
  }
  const info = unwrap(remote)?.info;
  const remoteName = String(info?.name ?? '');
  if (remoteName !== entry.expectedName) {
    throw new SyncError(
      `${entry.role}: ${entry.idVar} points at a collection named "${remoteName}", but this role `
      + `may only update "${entry.expectedName}". This is what a swapped or mistyped variable looks `
      + `like. No collection is searched for by name and no id is substituted — fix the variable.`,
    );
  }
  const id = info?._postman_id ?? info?.postman_id ?? null;
  const uid = info?.uid ?? null;
  if (!id && !uid) {
    throw new SyncError(
      `${entry.role}: the remote collection exposes no usable identity (neither info._postman_id `
      + `nor info.uid). Without it a full replacement cannot be addressed safely.`,
    );
  }
  if (!identityConsistent(configuredId, { id, uid })) {
    throw new SyncError(
      `${entry.role}: ${entry.idVar} (${fingerprint(configuredId)}) is not a representation of the `
      + `identity the remote returned (${fingerprint(id ?? '')} / uid ${fingerprint(uid ?? '')}). `
      + `Refusing to write to a target that does not match its configuration.`,
    );
  }
  // R3: `postman_id` is accepted for binding above, so it must also be RESTORED into the
  // payload. injectRemoteIds() starts from stripManaged(local), so anything omitted here is
  // simply absent — a remote whose identity is represented only by info.postman_id bound
  // successfully and was then sent without it. Exact remote values only: nothing is synthesized
  // and no other info field is carried over.
  return { id, uid, remoteInfoIdentity: pickManaged(info, INFO_IDENTITY_KEYS) };
}

/** The activation kill switch. Exactly 'true' enables writing; anything else does not. */
export function autopublishEnabled(env = process.env) {
  return env[ACTIVATION_VAR] === 'true';
}

// ───────────────────────────── Postman API ─────────────────────────────

async function postman(method, path, { apiKey, body } = {}) {
  let res;
  try {
    res = await fetch(`${POSTMAN_API}${path}`, {
      method,
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new SyncError(`${method} ${path} failed at the transport layer: ${redact(e.message, apiKey)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new SyncError(
      `${method} ${path} -> HTTP ${res.status}. Publication aborted; no fallback is attempted. `
      + `Response: ${redact(text, apiKey).slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SyncError(`${method} ${path} returned a 2xx that is not JSON`);
  }
}

const countRequests = (collection) => {
  let n = 0;
  const walk = (nodes) => { for (const x of nodes ?? []) { if (Array.isArray(x.item)) walk(x.item); else n++; } };
  walk(unwrap(collection)?.item);
  return n;
};

export function readLocal(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  } catch (e) {
    throw new SyncError(`${file} is not readable as JSON: ${e.message}`);
  }
  if (!parsed?.info?.name || !Array.isArray(parsed.item)) {
    throw new SyncError(`${file} does not look like a Postman collection (missing info.name or item[])`);
  }
  return parsed;
}

// ───────────────────────────── driver ─────────────────────────────

async function syncOne(entry, { apiKey, publish, log, env = process.env }) {
  const local = readLocal(entry.file);
  const configuredId = env[entry.idVar];
  if (!configuredId) {
    throw new SyncError(
      `${entry.idVar} is not set. Configure it as a repository variable holding the Postman cloud `
      + `collection id. The value inside ${entry.file} is a collection-document identifier and is `
      + `NOT a cloud id — publication will not guess one.`,
    );
  }

  const remote = await postman('GET', `/collections/${configuredId}`, { apiKey });

  // Bind the role to the target BEFORE anything else is considered.
  const { id, uid, remoteInfoIdentity } = assertTargetBinding({ entry, local, remote, configuredId });

  const localHash = contentHash(local);
  const remoteHash = contentHash(remote);
  const action = remoteHash === localHash ? 'NOOP' : 'UPDATE';

  log(`  role                 : ${entry.role}`);
  log(`  source file          : ${entry.file}`);
  log(`  collection name      : ${entry.expectedName} (asserted on both sides)`);
  log(`  configured id        : ${fingerprint(configuredId)}`);
  log(`  remote identity      : id ${fingerprint(id ?? '')} / uid ${fingerprint(uid ?? '')}`);
  log(`  repository sha       : ${env.GITHUB_SHA ?? '(local run)'}`);
  log(`  local normalized sha : ${localHash}`);
  log(`  remote normalized sha: ${remoteHash}`);
  log(`  request count (local): ${countRequests(local)}`);
  log(`  autopublish enabled  : ${autopublishEnabled(env) ? 'true' : `no (${ACTIVATION_VAR}=${env[ACTIVATION_VAR] ?? '(unset)'})`}`);
  log(`  ACTION               : ${action}`);

  if (action === 'NOOP') {
    log('  remote already matches the reviewed local file; no PUT issued.');
    return { role: entry.role, action, put: false, verified: true, localHash, remoteHash };
  }
  if (!publish) {
    log('  verify-only run: a PUT would be required. Not issuing it.');
    return { role: entry.role, action, put: false, verified: null, localHash, remoteHash };
  }
  if (!autopublishEnabled(env)) {
    throw new SyncError(
      `${entry.role}: a write is required but ${ACTIVATION_VAR} is not exactly 'true' `
      + `(currently ${env[ACTIVATION_VAR] ?? '(unset)'}). Autopublish is gated: run the verify `
      + `dispatch, have the result reviewed, and only then set ${ACTIVATION_VAR}=true.`,
    );
  }

  const idMap = buildIdentityMap(remote, { label: `remote ${entry.role} collection` });
  buildIdentityMap(local, { label: `local ${entry.file}` });   // fail closed on local ambiguity too
  const payload = injectRemoteIds(local, idMap, { remoteInfoIdentity });

  await postman('PUT', `/collections/${configuredId}`, { apiKey, body: { collection: payload } });

  // An HTTP 200 is not publication success. Re-read and compare the whole content.
  const after = await postman('GET', `/collections/${configuredId}`, { apiKey });
  const afterHash = contentHash(after);
  log(`  remote sha after PUT : ${afterHash}`);
  log(`  request count (remote): ${countRequests(after)}`);
  if (afterHash !== localHash) {
    throw new SyncError(
      `${entry.role}: POSTMAN_REMOTE_MATCH_LOCAL = NO. After the write the remote content still `
      + `differs from ${entry.file} (local ${localHash}, remote ${afterHash}). The difference is in `
      + `content we own, so it is NOT normalized away. Investigate before re-running.`,
    );
  }
  log('  POSTMAN_REMOTE_MATCH_LOCAL = YES');
  return { role: entry.role, action, put: true, verified: true, localHash, remoteHash: afterHash };
}

export async function main(argv = process.argv.slice(2), log = console.log, env = process.env) {
  const mode = argv.includes('--publish') ? 'publish' : argv.includes('--selftest') ? 'selftest' : 'verify';

  if (mode === 'selftest') {
    for (const e of COLLECTIONS) {
      const local = readLocal(e.file);
      if (local.info.name !== e.expectedName) {
        throw new SyncError(`${e.file} is named "${local.info.name}", expected "${e.expectedName}"`);
      }
      buildIdentityMap(local, { label: `local ${e.file}` });
      log(`OK  ${e.file}: "${local.info.name}", ${countRequests(local)} requests, normalized sha ${contentHash(local)}`);
    }
    log('\nBoth collections parse, are named as their role expects, carry unambiguous item identities, and hash deterministically.');
    return 0;
  }

  const apiKey = env.POSTMAN_API_KEY;
  if (!apiKey) {
    throw new SyncError('POSTMAN_API_KEY is not set. Configure it as a repository secret; this script never reads a key from anywhere else.');
  }
  if (mode === 'publish' && !autopublishEnabled(env)) {
    // Refuse before a single request goes out, not just before the PUT.
    throw new SyncError(
      `publish mode requires ${ACTIVATION_VAR}=true (currently ${env[ACTIVATION_VAR] ?? '(unset)'}). `
      + `Use --verify while autopublish is disabled.`,
    );
  }

  const results = [];
  for (const e of COLLECTIONS) {
    log(`\n## ${e.role}`);
    results.push(await syncOne(e, { apiKey, publish: mode === 'publish', log, env }));
  }
  log('\n## summary');
  for (const r of results) log(`  ${r.role}: ACTION=${r.action} put=${r.put} verified=${r.verified}`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`FAIL: ${redact(err.message, process.env.POSTMAN_API_KEY)}`);
    process.exit(1);
  });
}
