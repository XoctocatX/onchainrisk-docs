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
/**
 * THE THREE CANONICAL TARGETS (#748 cutover).
 *
 * This was two collections, one per tier, which is a statement that paid and sandbox are two
 * different integrations. They are one integration with two credentials, so the published shape
 * is ONE collection used with EITHER environment — and the publisher now models exactly that:
 *
 *   collection             OnChainRisk API            45 requests, bearer {{api_key}}
 *   environment            OnChainRisk Production     api_key = ocr_live_* · tier = production
 *   environment            OnChainRisk Sandbox        api_key = ocr_test_* · tier = sandbox
 *
 * Each is INDEPENDENTLY verifiable: its own configured id, its own remote identity, its own
 * local and remote normalized hash, and its own ACTION. A write to one never implies a write to
 * another, and `verify` issues none.
 *
 * The two retired collection id variables are deliberately NOT read any more. The old sandbox
 * cloud collection is retained and deprecated rather than deleted — users may have imported or
 * forked it — but it is not one of the three canonical artifacts and this script does not touch
 * it. Its deprecation is a separate, bounded write under its own gate.
 */
export const TARGETS = [
  {
    kind: 'collection',
    role: 'collection',
    file: 'onchainrisk_api_collection.json',
    idVar: 'POSTMAN_COLLECTION_ID',
    expectedName: 'OnChainRisk API',
  },
  {
    kind: 'environment',
    role: 'production-environment',
    file: 'production.postman_environment.json',
    idVar: 'POSTMAN_PRODUCTION_ENVIRONMENT_ID',
    expectedName: 'OnChainRisk Production',
  },
  {
    kind: 'environment',
    role: 'sandbox-environment',
    file: 'sandbox.postman_environment.json',
    idVar: 'POSTMAN_SANDBOX_ENVIRONMENT_ID',
    expectedName: 'OnChainRisk Sandbox',
  },
];

/** The collection target, for the places that are collection-specific by nature. */
export const COLLECTIONS = TARGETS.filter((t) => t.kind === 'collection');
export const ENVIRONMENTS = TARGETS.filter((t) => t.kind === 'environment');

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
/*
 * R4 splits what Postman owns into two kinds, because they are handled differently.
 *
 * IDENTITY — the handles Postman assigns to an entity. Normalized out of the comparison AND
 *   preserved into the outbound payload, because a full replacement that omits an existing id
 *   makes Postman delete and recreate that entity.
 *
 * SERVER_METADATA — values the server generates about an entity: timestamps, ownership,
 *   revision counters. Normalized out of the comparison but NEVER sent back. Postman regenerates
 *   them on write, so echoing them would be meaningless at best and a stale claim at worst.
 *
 * MANAGED (= IDENTITY + SERVER_METADATA per position) is what normalization strips.
 */
const IDENTITY = {
  // The export carries `info._postman_id`; the PUT documentation also cites `postman_id`.
  collectionInfo: ['_postman_id', 'postman_id', 'uid'],
  // v2.1 documents `id` on items; the API returns `uid` on items; PUT cites `postman_id`.
  item: ['id', 'uid', '_postman_id', 'postman_id'],
  // A response example likewise comes back with both `id` and `uid`.
  response: ['id', 'uid', '_postman_id', 'postman_id'],
  // R3 position-aware review: v2.1 documents `id` on event and script objects and the PUT
  // documentation cites `postman_id`, but neither the schema nor any response we model carries a
  // `uid` at these positions, so the speculative `uid` added in R2 was removed. Erring this way
  // is the safe direction — an unmodelled managed field surfaces as loud drift and a failed run,
  // whereas normalizing a field Postman does not own there would silently hide content changes.
  event: ['id', '_postman_id', 'postman_id'],
  eventScript: ['id', '_postman_id', 'postman_id'],
};

/**
 * Server-generated metadata, normalized for comparison and deliberately NOT echoed back.
 *
 * R4: a current GET returns `createdAt` / `updatedAt` on folders, requests and response examples
 * as well as on the collection. Neither checked-in collection carries them structurally (the
 * four `createdAt` strings in the paid collection are inside response-example BODIES, which is
 * our content), so every ordinary GET differed from the canonical file purely by server
 * timestamps — a false ACTION=UPDATE, and then a post-PUT verification that could never match
 * because the verifying GET added them again.
 */
const SERVER_METADATA = {
  collectionInfo: ['owner', 'fork', 'createdAt', 'updatedAt', 'lastUpdatedBy', 'lastRevision'],
  collectionTop: ['_postman_exported_at', '_postman_exported_using'],
  item: ['createdAt', 'updatedAt'],
  // `responseTime` is the latency Postman recorded when the example was captured — a fact about
  // one historical send, not about the contract. It is listed HERE, at the saved-example
  // position, and nowhere else: a `responseTime` inside an example BODY, a request body or any
  // nested business object is our content and keeps participating in the hash. Being server
  // metadata rather than identity, it is normalized away for comparison and never echoed back.
  response: ['createdAt', 'updatedAt', 'responseTime'],
};

/** Everything Postman owns at a given position = its identity plus its server metadata. */
const MANAGED = Object.fromEntries(
  [...new Set([...Object.keys(IDENTITY), ...Object.keys(SERVER_METADATA)])].map((kind) => [
    kind,
    [...new Set([...(IDENTITY[kind] ?? []), ...(SERVER_METADATA[kind] ?? [])])],
  ]),
);

/** Info-level identity representations that may be restored into a PUT payload. */
const INFO_IDENTITY_KEYS = IDENTITY.collectionInfo;

/** Reserved identity-map key for the collection root (its own event/script identities). */
export const COLLECTION_ROOT_KEY = 'collection:root';

/** Exported for tests: what is preserved vs merely normalized, per position. */
export const MANAGED_FIELDS = { IDENTITY, SERVER_METADATA, MANAGED };

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

/**
 * Postman's serializer writes `response: []` on a request that has no saved examples, while a
 * hand-authored collection simply omits the optional field. Both state "no saved examples", so
 * they must compare equal — otherwise every example-less request reports permanent drift and no
 * post-write verification can ever match, which is exactly what stopped the first publish.
 *
 * Narrow by construction, in three ways:
 *   - position: request items only, never a folder and never some other array in the document;
 *   - emptiness: only a zero-length array is dropped, so a non-empty `response` stays authored
 *     content and participates in the comparison and the hash in full — including an array whose
 *     sole example consisted entirely of managed keys and is now `{}`, which is a real
 *     difference and must still be reported;
 *   - direction: it removes an empty array, it never adds one.
 *
 * Comparison only. It is deliberately NOT part of stripManaged, because injectRemoteIds builds
 * the outbound payload from stripManaged — so the PUT body is unaffected by this function.
 */
function dropEmptyResponseArrays(collection) {
  for (const { holder, kind } of managedPositions(collection)) {
    if (kind !== 'item' || Array.isArray(holder.item)) continue;   // requests, not folders
    if (Array.isArray(holder.response) && holder.response.length === 0) delete holder.response;
  }
  return collection;
}

/**
 * The comparable content of a collection: ours, with Postman's identity removed and Postman's
 * optional-field serialization canonicalized. stripManaged already returns a clone, so this
 * mutates nothing the caller owns.
 */
export const normalizeForCompare = (collection) => dropEmptyResponseArrays(stripManaged(collection));

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
      // IDENTITY only — server metadata is normalized away but never echoed back.
      map.set(key, {
        item: pickManaged(n, IDENTITY.item),
        responses: subMap(n.response, (r) => String(r.name ?? ''), IDENTITY.response),
        events: subMap(n.event, (e) => String(e.listen ?? ''), IDENTITY.event),
        scripts: subMap(n.event, (e) => String(e.listen ?? ''), IDENTITY.eventScript, (e) => e.script),
      });
      if (Array.isArray(n.item)) walk(n.item, here);
    }
  };
  walk(c.item, []);
  // The collection root's own events, matched by `listen` like any other event list. A duplicate
  // `listen` drops that entry, so the id is omitted rather than guessed.
  map.set(COLLECTION_ROOT_KEY, {
    events: subMap(c.event, (e) => String(e.listen ?? ''), IDENTITY.event),
    scripts: subMap(c.event, (e) => String(e.listen ?? ''), IDENTITY.eventScript, (e) => e.script),
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

// ──────────────────────── safe structural diff (diagnostic) ────────────────────────
//
// Answers "what would change if we publish?" without printing a single value. It compares the
// two already-normalized collections, so it sees exactly what the NOOP/UPDATE decision sees,
// and it reports PATHS and CATEGORIES only — never old/new content, never a body, never a
// header value, never an id. Purely diagnostic: it reads normalized copies and influences
// nothing about binding, normalization, identity, the payload or verification.

/** Patterns that must never be echoed, even when they appear in a structural label. */
const SECRET_SHAPED = [
  /PMAK-[A-Za-z0-9]{6,}/,
  /ocr_(live|test|sandbox)_[A-Za-z0-9]{6,}/,
  /eyJ[A-Za-z0-9_-]{15,}/,
  /\bBearer\s+\S{6,}/i,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,          // long base64-ish blob
  /\b[0-9a-f]{32,}\b/i,                    // long hex blob
];

const LABEL_MAX = 80;

/** C0, DEL, C1 and the Unicode line separators: anything that could forge a log line. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const fp = (raw) => createHash('sha256').update(raw).digest('hex').slice(0, 8);

/**
 * THE one path-component safety policy. Every externally-derived component that can reach
 * formatSafeDiff() goes through this — folder and request names, HTTP method, each URL path
 * segment, example names, event `listen`, header / variable / query keys, and object property
 * keys. R1: three surfaces previously bypassed it (the URL path, the method, and arbitrary
 * object keys), each of which could put a credential or a forged log line into an Actions log.
 *
 * Order matters. Control characters are neutralised first so a newline cannot escape the line
 * even if the rest of the label is later redacted or truncated; the secret check then runs on
 * the ORIGINAL text, so splitting a credential with a tab does not smuggle it past.
 */
export function safeComponent(value, { kind = 'label' } = {}) {
  const raw = value === undefined || value === null ? '' : String(value);
  if (!raw) return `<no ${kind}>`;

  /*
   * R2: a control character must not be able to SPLIT a credential past the detector. A key
   * whose prefix is separated from its body by a TAB matches no secret shape as written, yet
   * the neutralised render would have printed the two halves joined by a placeholder — nearly
   * the whole token. (The literal form is not written here, so the repository secret-shape scan
   * stays meaningful; see the split fixtures in the tests.) So every shape is
   * tested against three canonical forms: the raw text, the text with control characters
   * removed (which rejoins a split token), and with them turned into spaces (which keeps two
   * genuinely separate words apart). Only the neutralised safe form is ever rendered; no
   * reconstructed canonical form is printed.
   */
  const candidates = [raw, raw.replace(CONTROL_CHARS, ''), raw.replace(CONTROL_CHARS, ' ')];
  if (SECRET_SHAPED.some((re) => candidates.some((c) => re.test(c)))) {
    return `<redacted ${kind} sha256:${fp(raw)}>`;
  }

  const tame = raw.replace(CONTROL_CHARS, '·');
  if (tame.length > LABEL_MAX) {
    /*
     * R2: a truncated component is also a SEMANTIC SELECTOR, so it has to stay unique. Two
     * labels sharing their first LABEL_MAX characters and their total length rendered
     * identically, which paired two distinct folders as one entity and turned a real
     * remove-plus-add into a misleading nested CHANGED. The fingerprint of the full component
     * restores identity while still exposing only the readable prefix.
     */
    return `${tame.slice(0, LABEL_MAX)}…<truncated ${tame.length} sha256:${fp(raw)}>`;
  }
  return tame;
}

/** Retained name for the same policy; `safeLabel` is what the earlier tests call. */
export const safeLabel = safeComponent;

/**
 * Property names from the Collection v2.1 schema and the collection API, which are structure
 * rather than content and so are readable as they are. Anything NOT on this list is arbitrary
 * — an extension field, or user data — and is fingerprinted instead of echoed.
 */
const KNOWN_KEYS = new Set([
  'info', 'name', 'description', 'schema', 'version', 'variable', 'item', 'event', 'auth',
  'protocolProfileBehavior', '_postman_id', 'postman_id', 'uid', 'owner', 'fork', 'createdAt',
  'updatedAt', 'lastUpdatedBy', 'lastRevision', '_postman_exported_at', '_postman_exported_using',
  'request', 'response', 'method', 'url', 'header', 'headers', 'body', 'raw', 'mode', 'options',
  'urlencoded', 'formdata', 'file', 'graphql', 'src', 'disabled', 'key', 'value', 'type', 'id',
  'protocol', 'host', 'path', 'port', 'query', 'hash', 'originalRequest', 'status', 'code',
  'cookie', 'responseTime', 'responseSize', 'language', '_postman_previewlanguage',
  'listen', 'script', 'exec', 'packages', 'prerequest', 'test', 'saveOptions',
  'bearer', 'basic', 'apikey', 'oauth2', 'noauth', 'token', 'username', 'password', 'in',
  'content', 'contentType', 'major', 'minor', 'patch', 'identifier', 'meta', 'variables',
]);

/**
 * A property key in a rendered path. Known schema keys stay literal so ordinary paths read
 * well; anything else is fingerprinted, because an extension field's KEY can itself be
 * sensitive and the renderer must not decide that by looking at it.
 */
export function safeKey(key) {
  const raw = String(key ?? '');
  if (KNOWN_KEYS.has(raw)) return raw;
  return `<key sha256:${fp(raw)}>`;
}

/**
 * The normalized URL path, sanitised segment by segment so `POST /api/v1/check` stays readable
 * while a secret-shaped segment is redacted on its own rather than destroying the whole path.
 */
export function safePath(url) {
  const normalized = normalizePath(url);
  if (!normalized) return '';
  return normalized
    .split('/')
    .map((seg) => (seg === '' ? '' : safeComponent(seg, { kind: 'path segment' })))
    .join('/');
}

/**
 * Methods a Postman collection can legitimately carry — HTTP plus the WebDAV verbs Postman
 * offers in its method picker. This is an ALLOWLIST on purpose.
 *
 * R2: the previous shape test `/^[A-Z]{3,10}$/` fell through to safeComponent(), which returns
 * ordinary non-secret text literally — so `GET /etc/passwd; rm -rf` was echoed as
 * `GET /ETC/PASSWD; RM -RF`. Worse, my own test passed because it searched for the lowercase
 * form after production code had upper-cased it: green for the wrong reason. Anything not on
 * this list is now fingerprinted and never rendered.
 */
const KNOWN_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT',
  'COPY', 'LINK', 'UNLINK', 'PURGE', 'LOCK', 'UNLOCK', 'PROPFIND', 'PROPPATCH',
  'MKCOL', 'MOVE', 'REPORT', 'SEARCH', 'VIEW',
]);

/** An HTTP method is not assumed trustworthy: only an accepted verb renders literally. */
export function safeMethod(method) {
  const raw = String(method ?? '');
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (KNOWN_METHODS.has(upper)) return upper;
  return `<method sha256:${fp(raw)}>`;
}

/** A folder is identified by name; a request by method plus normalized path. */
function itemLabel(node) {
  if (!isObj(node)) return null;
  if (Array.isArray(node.item)) return safeComponent(node.name, { kind: 'folder name' });
  const method = safeMethod(node.request?.method);
  const path = safePath(node.request?.url);
  if (!method && !path) return safeComponent(node.name, { kind: 'request name' });
  return `${method} ${path}`.trim();
}

/** Arrays that have a stable semantic identity, and how to derive it. */
const ARRAY_KEYERS = {
  item: itemLabel,
  response: (x) => safeComponent(x?.name, { kind: 'example name' }),
  event: (x) => safeComponent(x?.listen, { kind: 'listen' }),
  header: (x) => safeComponent(x?.key, { kind: 'header name' }),
  headers: (x) => safeComponent(x?.key, { kind: 'header name' }),
  variable: (x) => safeComponent(x?.key, { kind: 'variable name' }),
  query: (x) => safeComponent(x?.key, { kind: 'query name' }),
};

/** Can this array be keyed semantically — every element yielding a distinct, non-empty key? */
function keyable(arr, field) {
  const keyer = ARRAY_KEYERS[field];
  if (!keyer || !Array.isArray(arr)) return false;
  const keys = arr.map((x) => keyer(x));
  return keys.every((k) => k !== null && k !== undefined && k !== '')
    && new Set(keys).size === keys.length;
}

/**
 * Index an array for comparison.
 *
 * The strategy is decided ONCE FOR THE PAIR, by the caller, and applied to both sides. Indexing
 * each side independently produced incoherent output when one side was keyable and the other was
 * not: the paid collection genuinely has two events with `listen: "test"` on one request, so a
 * remote with a single `test` event reported `event[0]`/`event[1]` as ADDED *and*
 * `event[test]` as REMOVED — describing one edit as three unrelated ones.
 */
function indexArray(arr, field, semantic) {
  if (semantic) {
    const keyer = ARRAY_KEYERS[field];
    return arr.map((x, i) => [`[${keyer(x)}]`, arr[i]]);
  }
  return arr.map((x, i) => [`[${i}]`, x]);
}

const isLeafArray = (a) => Array.isArray(a) && a.every((x) => !isObj(x) && !Array.isArray(x));

/**
 * Structural differences between two normalized collections.
 *
 * Direction: `local` is the state we would publish, `remote` is what Postman holds now. So
 * ADDED means present locally and absent remotely — it would be created; REMOVED means present
 * remotely and absent locally — it would be deleted.
 *
 * @returns {{added:string[], removed:string[], changed:string[]}} sorted, value-free paths
 */
export function safeDiff(local, remote) {
  const added = [];
  const removed = [];
  const changed = [];

  const walk = (a, b, path, fieldOf = '') => {
    const aMissing = a === undefined;
    const bMissing = b === undefined;
    if (aMissing && bMissing) return;
    if (bMissing) { added.push(path); return; }
    if (aMissing) { removed.push(path); return; }

    const aObj = isObj(a);
    const bObj = isObj(b);
    const aArr = Array.isArray(a);
    const bArr = Array.isArray(b);

    if (aObj && bObj) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        // R1: the key is externally derived too — an extension field's name can itself be
        // sensitive, so it goes through the same policy as every other component.
        const rendered = safeKey(k);
        walk(a[k], b[k], path ? `${path}.${rendered}` : rendered, k);
      }
      return;
    }
    if (aArr && bArr) {
      // An array of scalars is reported as one changed path rather than per element: the
      // element positions carry no stable identity and naming them edges toward values.
      if (isLeafArray(a) && isLeafArray(b)) {
        if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(path);
        return;
      }
      // `fieldOf` is tracked separately from the rendered path: the keyer lookup needs the raw
      // schema key, which a rendered path may have fingerprinted.
      const field = fieldOf;
      // both sides must be keyable, or neither is keyed
      const semantic = keyable(a, field) && keyable(b, field);
      const ai = new Map(indexArray(a, field, semantic));
      const bi = new Map(indexArray(b, field, semantic));
      for (const key of new Set([...ai.keys(), ...bi.keys()])) {
        walk(ai.get(key), bi.get(key), `${path}${key}`, fieldOf);
      }
      return;
    }
    // shape change, or two differing scalars
    if (aObj !== bObj || aArr !== bArr || JSON.stringify(a) !== JSON.stringify(b)) changed.push(path);
  };

  walk(normalizeForCompare(local), normalizeForCompare(remote), '');

  const dedupeSort = (xs) => [...new Set(xs)].sort();
  return { added: dedupeSort(added), removed: dedupeSort(removed), changed: dedupeSort(changed) };
}

/** Render the diff for a log, capped so one large drift cannot bury the rest of the run. */
export function formatSafeDiff(diff, { max = 40, log = console.log } = {}) {
  log('  diff summary (paths only — no values, no ids, no bodies):');
  log(`    added   : ${diff.added.length}`);
  log(`    removed : ${diff.removed.length}`);
  log(`    changed : ${diff.changed.length}`);
  for (const [label, paths] of [['added', diff.added], ['removed', diff.removed], ['changed', diff.changed]]) {
    if (!paths.length) continue;
    // A blank line is emitted as its own call, never embedded: every line this function hands to
    // the logger must be exactly one line, so "no control character in any emitted line" is a
    // property the caller can rely on.
    log('');
    log(`    ${label} paths:`);
    for (const p of paths.slice(0, max)) log(`      ${p}`);
    if (paths.length > max) log(`      …and ${paths.length - max} more`);
  }
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
  // TWO shapes are published now, and each is shape-checked as itself rather than one being
  // waved through: a COLLECTION has info.name and item[], an ENVIRONMENT has name and values[].
  // A file that is neither is rejected, so a truncated or wrong-kind document cannot reach the
  // comparison and read as "everything differs".
  const isCollection = Boolean(parsed?.info?.name) && Array.isArray(parsed.item);
  const isEnvironment = typeof parsed?.name === 'string' && Array.isArray(parsed.values);
  if (!isCollection && !isEnvironment) {
    throw new SyncError(
      `${file} is neither a Postman collection (info.name + item[]) nor a Postman environment `
      + '(name + values[])',
    );
  }
  return parsed;
}

// ───────────────────────────── environments ─────────────────────────────
//
// An environment document is far simpler than a collection — a name and a flat list of
// {key, value, type, enabled, description} — so it gets its own small, explicit path rather
// than being forced through machinery built for folders, requests and saved examples. Every
// safety property of the collection path is kept: identity is asserted before anything else,
// the comparison is a normalized hash, a verify run issues no write, and a PUT is followed by a
// re-read that must match or the run fails.

/**
 * What Postman owns on an environment. `id` is the cloud identity; the rest is server metadata
 * or export bookkeeping. Normalizing them away is what stops every ordinary GET from reporting a
 * false ACTION=UPDATE — the same defect that stalled the first collection publish, in the shape
 * an environment takes.
 */
export const ENVIRONMENT_MANAGED = [
  'id', 'uid', 'owner', 'createdAt', 'updatedAt', 'isPublic',
  '_postman_variable_scope', '_postman_exported_at', '_postman_exported_using',
];

/**
 * The comparable content of an environment: its NAME and its variables, keyed by variable name
 * so Postman's ordering cannot read as a change. A variable's `value` participates in full —
 * these are published PLACEHOLDERS, and a placeholder silently replaced by a real credential is
 * precisely what a reviewer needs the hash to catch.
 */
export function normalizeEnvironmentForCompare(doc) {
  const d = clone(doc?.environment ?? doc);
  for (const k of ENVIRONMENT_MANAGED) delete d[k];
  const values = (d.values ?? []).map((v) => {
    const out = { ...v };
    delete out.id;
    return out;
  });
  values.sort((a, b) => (String(a.key) < String(b.key) ? -1 : 1));
  return { name: d.name, values };
}

/** Stable, key-order-independent hash of an environment's comparable content. */
export function environmentContentHash(doc) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (!isObj(v)) return v;
    return Object.keys(v).sort().reduce((a, k) => { a[k] = sortKeys(v[k]); return a; }, {});
  };
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(normalizeEnvironmentForCompare(doc)))).digest('hex');
}

/**
 * Bind the role to the target BEFORE anything else is considered — the same rule the collection
 * path follows, and for the same reason: publishing the production environment over the sandbox
 * one would hand every reader a live-key placeholder where they expected a test one.
 */
export function assertEnvironmentBinding({ entry, local, remote, configuredId }) {
  const r = remote?.environment ?? remote ?? {};
  if (local.name !== entry.expectedName) {
    throw new SyncError(
      `${entry.file} is named "${local.name}", expected "${entry.expectedName}". The file and the `
      + 'role must agree before any id is trusted.',
    );
  }
  if (r.name !== entry.expectedName) {
    throw new SyncError(
      `${entry.idVar} points at a Postman environment named "${r.name}", but ${entry.role} `
      + `expects "${entry.expectedName}". Refusing to write: the configured id is bound to the `
      + 'wrong environment.',
    );
  }
  if (!identityConsistent(configuredId, { id: r.id, uid: r.uid })) {
    throw new SyncError(
      `${entry.idVar} (${fingerprint(configuredId)}) does not match the remote environment `
      + `identity (id ${fingerprint(r.id ?? '')} / uid ${fingerprint(r.uid ?? '')}).`,
    );
  }
  return { id: r.id, uid: r.uid };
}

async function syncEnvironment(entry, { apiKey, publish, log, env = process.env }) {
  const local = readLocal(entry.file);
  const configuredId = env[entry.idVar];
  if (!configuredId) {
    throw new SyncError(
      `${entry.idVar} is not set. Configure it as a repository variable holding the Postman cloud `
      + `environment id. The \`id\` inside ${entry.file} is a document identifier and is NOT a `
      + 'cloud id — publication will not guess one, and will not create one.',
    );
  }

  const remote = await postman('GET', `/environments/${configuredId}`, { apiKey });
  const { id, uid } = assertEnvironmentBinding({ entry, local, remote, configuredId });

  const localHash = environmentContentHash(local);
  const remoteHash = environmentContentHash(remote);
  const action = remoteHash === localHash ? 'NOOP' : 'UPDATE';
  const localKeys = normalizeEnvironmentForCompare(local).values.map((v) => v.key);

  log(`  role                 : ${entry.role}`);
  log(`  kind                 : environment`);
  log(`  source file          : ${entry.file}`);
  log(`  environment name     : ${entry.expectedName} (asserted on both sides)`);
  log(`  configured id        : ${fingerprint(configuredId)}`);
  log(`  remote identity      : id ${fingerprint(id ?? '')} / uid ${fingerprint(uid ?? '')}`);
  log(`  repository sha       : ${env.GITHUB_SHA ?? '(local run)'}`);
  log(`  local normalized sha : ${localHash}`);
  log(`  remote normalized sha: ${remoteHash}`);
  log(`  variables (local)    : ${localKeys.length} — ${localKeys.join(', ')}`);
  log(`  autopublish enabled  : ${autopublishEnabled(env) ? 'true' : `no (${ACTIVATION_VAR}=${env[ACTIVATION_VAR] ?? '(unset)'})`}`);
  log(`  ACTION               : ${action}`);

  if (action === 'NOOP') {
    log('  remote already matches the reviewed local file; no PUT issued.');
    return { role: entry.role, action, put: false, verified: true, localHash, remoteHash };
  }

  // Show a reviewer WHICH variables differ, by key — never a value, because a value may be a
  // placeholder a reader is about to be told to replace with a real credential.
  const l = new Map(normalizeEnvironmentForCompare(local).values.map((v) => [v.key, v]));
  const r = new Map(normalizeEnvironmentForCompare(remote).values.map((v) => [v.key, v]));
  for (const k of [...new Set([...l.keys(), ...r.keys()])].sort()) {
    if (!r.has(k)) log(`    + ${safeKey(k)} (local only)`);
    else if (!l.has(k)) log(`    - ${safeKey(k)} (remote only)`);
    else if (JSON.stringify(l.get(k)) !== JSON.stringify(r.get(k))) log(`    ~ ${safeKey(k)} differs`);
  }

  if (!publish) {
    log('  verify-only run: a PUT would be required. Not issuing it.');
    return { role: entry.role, action, put: false, verified: null, localHash, remoteHash };
  }
  if (!autopublishEnabled(env)) {
    throw new SyncError(
      `${entry.role}: a write is required but ${ACTIVATION_VAR} is not exactly 'true' `
      + `(currently ${env[ACTIVATION_VAR] ?? '(unset)'}).`,
    );
  }

  // The PUT keeps the remote's own cloud id and carries our name and values. No create path.
  const payload = { ...normalizeEnvironmentForCompare(local), id };
  await postman('PUT', `/environments/${configuredId}`, { apiKey, body: { environment: payload } });

  // An HTTP 200 is not publication success. Re-read and compare.
  const after = await postman('GET', `/environments/${configuredId}`, { apiKey });
  const afterHash = environmentContentHash(after);
  log(`  remote sha after PUT : ${afterHash}`);
  if (afterHash !== localHash) {
    throw new SyncError(
      `${entry.role}: the PUT returned 200 but the remote does not match the reviewed file `
      + `(local ${localHash}, remote ${afterHash}). Treat the remote as HALF-WRITTEN and inspect `
      + 'it before any retry.',
    );
  }
  log('  POSTMAN_REMOTE_MATCH_LOCAL = YES');
  return { role: entry.role, action, put: true, verified: true, localHash, remoteHash: afterHash };
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

  // ACTION=UPDATE only: show a reviewer WHAT would change, structurally and without values.
  formatSafeDiff(safeDiff(local, remote), { log });

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
    for (const e of TARGETS) {
      const local = readLocal(e.file);
      if (e.kind === 'collection') {
        if (local.info.name !== e.expectedName) {
          throw new SyncError(`${e.file} is named "${local.info.name}", expected "${e.expectedName}"`);
        }
        buildIdentityMap(local, { label: `local ${e.file}` });
        log(`OK  ${e.file}: "${local.info.name}", ${countRequests(local)} requests, normalized sha ${contentHash(local)}`);
      } else {
        if (local.name !== e.expectedName) {
          throw new SyncError(`${e.file} is named "${local.name}", expected "${e.expectedName}"`);
        }
        const keys = normalizeEnvironmentForCompare(local).values.map((v) => v.key);
        if (new Set(keys).size !== keys.length) {
          throw new SyncError(`${e.file} declares a duplicate variable key`);
        }
        log(`OK  ${e.file}: "${local.name}", ${keys.length} variables, normalized sha ${environmentContentHash(local)}`);
      }
    }

    // THE DROP-IN INVARIANT, asserted in the publisher itself and not only in the serving
    // repository: the two environments must declare exactly the same variable NAMES, or the one
    // collection cannot run on either credential without being edited.
    const [prod, sandbox] = ENVIRONMENTS.map((e) => normalizeEnvironmentForCompare(readLocal(e.file)).values.map((v) => v.key));
    if (JSON.stringify(prod) !== JSON.stringify(sandbox)) {
      throw new SyncError(
        'the two environments do not declare the same variable names, so the single collection '
        + `cannot run on either credential unchanged (production: ${prod.join(', ')}; `
        + `sandbox: ${sandbox.join(', ')})`,
      );
    }
    // And no tier-named credential variable may exist in any of the three.
    for (const e of TARGETS) {
      const text = JSON.stringify(readLocal(e.file));
      for (const forbidden of ['paid_api_key', 'sandbox_api_key']) {
        if (text.includes(forbidden)) {
          throw new SyncError(
            `${e.file} references the forbidden tier-named credential variable \`${forbidden}\`. `
            + 'One collection runs on either credential: the only credential variable is `api_key`.',
          );
        }
      }
    }
    log(`\nOne collection and two environments parse, are named as their role expects, carry `
      + `unambiguous identities, declare the SAME ${prod.length} variable names, use no `
      + `tier-named credential variable, and hash deterministically.`);
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
  for (const e of TARGETS) {
    log(`\n## ${e.role}`);
    const sync = e.kind === 'collection' ? syncOne : syncEnvironment;
    results.push(await sync(e, { apiKey, publish: mode === 'publish', log, env }));
  }
  log('\n## summary');
  for (const r of results) log(`  ${r.role}: ACTION=${r.action} put=${r.put} verified=${r.verified}`);
  // A verify run must never have written. Stated as a line a reviewer can read, not inferred.
  if (mode !== 'publish') log(`  WRITES_ISSUED = ${results.filter((r) => r.put).length} (verify issues none)`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`FAIL: ${redact(err.message, process.env.POSTMAN_API_KEY)}`);
    process.exit(1);
  });
}
