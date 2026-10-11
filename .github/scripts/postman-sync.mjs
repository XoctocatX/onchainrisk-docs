#!/usr/bin/env node
/**
 * Publish this repository's reviewed Postman collections to Postman cloud.
 *
 * AUTHORITY. The checked-in JSON in this repository is the only content authority. It arrives
 * here by mirror sync from the CORE repository, which already gates OpenAPI <-> Postman
 * conformance, so this script does NOT regenerate anything from OpenAPI and never treats the
 * remote collection as a source of truth. The chain is:
 *
 *     CORE canonical -> production served artifacts -> this mirror -> Postman cloud
 *
 * The remote collection is fetched for exactly two reasons: to decide whether a write is needed
 * at all, and to recover Postman-managed item IDs so that an unchanged request keeps its ID.
 * Postman's full-collection replacement deletes and recreates any item whose ID is omitted,
 * which would churn IDs that deep links and attached resources depend on.
 *
 * SAFETY. Every failure mode fails closed: a missing credential or collection ID, any non-2xx
 * from Postman, an ambiguous or duplicated item identity, or a post-write verification that does
 * not match the local file. There is no create-new-collection fallback and no name-based
 * discovery — the script only ever updates the two collection IDs it is given.
 *
 * Standard library only; no dependencies, no package manager.
 *
 *   node .github/scripts/postman-sync.mjs --verify        read-only: report NOOP/UPDATE and exit
 *   node .github/scripts/postman-sync.mjs --publish       write when needed, then verify
 *   node .github/scripts/postman-sync.mjs --selftest      parse local files, no network
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const POSTMAN_API = 'https://api.postman.com';

/** The two collections this repository publishes. Nothing else is ever touched. */
export const COLLECTIONS = [
  { role: 'paid', file: 'paid-collection.json', idVar: 'POSTMAN_PAID_COLLECTION_ID' },
  { role: 'sandbox', file: 'onchainrisk_sandbox_api_collection.json', idVar: 'POSTMAN_SANDBOX_COLLECTION_ID' },
];

/**
 * Fields Postman owns, which therefore cannot participate in a content comparison.
 *
 * Deliberately narrow. Anything not listed here — name, description, request, url, headers,
 * body, auth, event scripts, variables, response examples — is OUR content, and a difference in
 * it is a real difference that must surface rather than be normalized away.
 */
const MANAGED_COLLECTION_KEYS = ['_postman_id', 'uid', 'owner', 'fork', 'createdAt', 'updatedAt', 'lastUpdatedBy', 'lastRevision'];
const MANAGED_ITEM_KEYS = ['id', 'uid', '_postman_id'];
const MANAGED_TOP_KEYS = ['_postman_exported_at', '_postman_exported_using'];

export class SyncError extends Error {}

/** Strip a secret from any text before it can reach a log, a message or an exit code. */
export function redact(text, secret) {
  const s = String(text ?? '');
  if (!secret) return s;
  return s.split(secret).join('***redacted***');
}

/** A short, non-reversible fingerprint so a configured ID is auditable without being echoed. */
export function fingerprint(value) {
  const v = String(value ?? '');
  if (!v) return '(unset)';
  const h = createHash('sha256').update(v).digest('hex').slice(0, 8);
  return `len=${v.length} sha256:${h} …${v.slice(-4)}`;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Deep clone without structuredClone, so the output is plain JSON-safe data. */
const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * The comparable content of a collection: our content with Postman-managed identifiers removed.
 * Used for the NOOP decision and for post-write verification.
 */
export function normalizeForCompare(collection) {
  const c = clone(collection?.collection ?? collection);
  for (const k of MANAGED_TOP_KEYS) delete c[k];
  if (isObj(c.info)) for (const k of MANAGED_COLLECTION_KEYS) delete c.info[k];
  const strip = (nodes) => {
    for (const n of nodes ?? []) {
      for (const k of MANAGED_ITEM_KEYS) delete n[k];
      if (Array.isArray(n.item)) strip(n.item);
      if (Array.isArray(n.response)) for (const r of n.response) for (const k of MANAGED_ITEM_KEYS) delete r[k];
    }
  };
  if (Array.isArray(c.item)) strip(c.item);
  return c;
}

/** Stable, order-independent hash of the comparable content. */
export function contentHash(collection) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (!isObj(v)) return v;
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortKeys(v[k]); return acc; }, {});
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

/**
 * Stable identity of an item. Folders are identified by full ancestry; requests additionally by
 * method and normalized path, which is the reviewed-operation identity the contract gates use.
 */
export const folderKey = (ancestry) => `folder:${ancestry.join(' / ')}`;
export const requestKey = (ancestry, method, url) =>
  `request:${ancestry.join(' / ')}|${String(method ?? '').toUpperCase()}|${normalizePath(url)}`;

/**
 * Map every item in a collection to its Postman-managed ID by stable identity.
 * Throws on a duplicated identity: an ambiguous map cannot be used to place IDs safely.
 */
export function buildIdentityMap(collection, { label = 'collection' } = {}) {
  const c = collection?.collection ?? collection;
  const map = new Map();
  const seen = new Map();
  const walk = (nodes, ancestry) => {
    for (const n of nodes ?? []) {
      const name = String(n.name ?? '');
      const here = [...ancestry, name];
      const key = Array.isArray(n.item) ? folderKey(here) : requestKey(ancestry, n.request?.method, n.request?.url);
      if (seen.has(key)) {
        throw new SyncError(
          `${label}: ambiguous identity ${key} — "${seen.get(key)}" and "${name}" resolve to the same `
          + `stable identity, so a Postman ID cannot be assigned unambiguously. Rename one, or give `
          + `them distinct method/path, and re-run.`,
        );
      }
      seen.set(key, name);
      const id = n.id ?? n._postman_id ?? null;
      if (id) map.set(key, { id, responses: responseIds(n) });
      if (Array.isArray(n.item)) walk(n.item, here);
    }
  };
  walk(c.item, []);
  return map;
}

/** Response-example IDs keyed by example name, only where the name is unambiguous. */
function responseIds(item) {
  const out = new Map();
  const dupes = new Set();
  for (const r of item.response ?? []) {
    const k = String(r.name ?? '');
    if (out.has(k)) { dupes.add(k); continue; }
    if (r.id) out.set(k, r.id);
  }
  for (const d of dupes) out.delete(d);   // ambiguous example name: preserve no ID
  return out;
}

/**
 * The outbound payload: LOCAL content, with remote Postman-managed IDs injected wherever the
 * identity matches unambiguously. No remote content is copied back — not a description, not a
 * script, not a variable, not an auth value, not a header, not an example body.
 */
export function injectRemoteIds(local, remoteIdMap, { remoteCollectionId = null } = {}) {
  const out = clone(local?.collection ?? local);
  const walk = (nodes, ancestry) => {
    for (const n of nodes ?? []) {
      const name = String(n.name ?? '');
      const here = [...ancestry, name];
      const key = Array.isArray(n.item) ? folderKey(here) : requestKey(ancestry, n.request?.method, n.request?.url);
      const hit = remoteIdMap.get(key);
      if (hit) {
        n.id = hit.id;                                    // keep the ID Postman already assigned
        for (const r of n.response ?? []) {
          const rid = hit.responses?.get(String(r.name ?? ''));
          if (rid) r.id = rid;
        }
      } else {
        delete n.id;                                      // new item: let Postman mint an ID
        delete n._postman_id;
        for (const r of n.response ?? []) { delete r.id; delete r.uid; }
      }
      if (Array.isArray(n.item)) walk(n.item, here);
    }
  };
  walk(out.item, []);
  // The API addresses the collection by its cloud identity; the checked-in file keeps its own.
  if (remoteCollectionId && isObj(out.info)) out.info._postman_id = remoteCollectionId;
  return out;
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
    // Body may echo request context; redact before it reaches a log.
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
  walk((collection?.collection ?? collection)?.item);
  return n;
};

export function readLocal(file) {
  const path = resolve(REPO_ROOT, file);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new SyncError(`${file} is not readable as JSON: ${e.message}`);
  }
  if (!parsed?.info?.name || !Array.isArray(parsed.item)) {
    throw new SyncError(`${file} does not look like a Postman collection (missing info.name or item[])`);
  }
  return parsed;
}

// ───────────────────────────── driver ─────────────────────────────

async function syncOne(entry, { apiKey, publish, log }) {
  const local = readLocal(entry.file);
  const collectionId = process.env[entry.idVar];
  if (!collectionId) {
    throw new SyncError(
      `${entry.idVar} is not set. Configure it as a repository variable holding the Postman cloud `
      + `collection ID. The value inside ${entry.file} is a collection-document identifier and is `
      + `NOT a cloud ID — publication will not guess one.`,
    );
  }

  const localHash = contentHash(local);
  const remote = await postman('GET', `/collections/${collectionId}`, { apiKey });
  const remoteHash = contentHash(remote);
  const action = remoteHash === localHash ? 'NOOP' : 'UPDATE';

  // Auditable publication decision, before any write. No secrets.
  log(`  role                 : ${entry.role}`);
  log(`  source file          : ${entry.file}`);
  log(`  collection name      : ${local.info.name}`);
  log(`  configured id        : ${fingerprint(collectionId)}`);
  log(`  repository sha       : ${process.env.GITHUB_SHA ?? '(local run)'}`);
  log(`  local normalized sha : ${localHash}`);
  log(`  remote normalized sha: ${remoteHash}`);
  log(`  request count (local): ${countRequests(local)}`);
  log(`  ACTION               : ${action}`);

  if (action === 'NOOP') {
    log('  remote already matches the reviewed local file; no PUT issued.');
    return { role: entry.role, action, put: false, verified: true, localHash, remoteHash };
  }
  if (!publish) {
    log('  verify-only run: a PUT would be required. Not issuing it.');
    return { role: entry.role, action, put: false, verified: null, localHash, remoteHash };
  }

  const idMap = buildIdentityMap(remote, { label: `remote ${entry.role} collection` });
  buildIdentityMap(local, { label: `local ${entry.file}` });   // fail closed on local ambiguity too
  const payload = injectRemoteIds(local, idMap, { remoteCollectionId: collectionId });

  await postman('PUT', `/collections/${collectionId}`, { apiKey, body: { collection: payload } });

  // An HTTP 200 is not publication success. Re-read and compare the whole content.
  const after = await postman('GET', `/collections/${collectionId}`, { apiKey });
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

export async function main(argv = process.argv.slice(2), log = console.log) {
  const mode = argv.includes('--publish') ? 'publish' : argv.includes('--selftest') ? 'selftest' : 'verify';

  if (mode === 'selftest') {
    for (const e of COLLECTIONS) {
      const local = readLocal(e.file);
      buildIdentityMap(local, { label: `local ${e.file}` });
      log(`OK  ${e.file}: "${local.info.name}", ${countRequests(local)} requests, normalized sha ${contentHash(local)}`);
    }
    log('\nBoth collections parse, carry unambiguous item identities, and hash deterministically.');
    return 0;
  }

  const apiKey = process.env.POSTMAN_API_KEY;
  if (!apiKey) {
    throw new SyncError('POSTMAN_API_KEY is not set. Configure it as a repository secret; this script never reads a key from anywhere else.');
  }

  const results = [];
  for (const e of COLLECTIONS) {
    log(`\n## ${e.role}`);
    results.push(await syncOne(e, { apiKey, publish: mode === 'publish', log }));
  }
  log('\n## summary');
  for (const r of results) log(`  ${r.role}: ACTION=${r.action} put=${r.put} verified=${r.verified}`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((err) => {
    // Redact defensively: an error path must never be the thing that leaks the key.
    console.error(`FAIL: ${redact(err.message, process.env.POSTMAN_API_KEY)}`);
    process.exit(1);
  });
}
