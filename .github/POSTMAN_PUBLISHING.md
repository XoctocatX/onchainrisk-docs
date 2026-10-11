# Postman publishing

How the two public collections in this repository reach Postman cloud, and what a maintainer
has to configure once before the first publish.

## What publishes, and from where

```
XoctocatX/onchainrisk (canonical)
  -> production served artifacts at api.onchainrisk.io
    -> this mirror  (paid-collection.json, onchainrisk_sandbox_api_collection.json)
      -> Postman cloud
```

The checked-in JSON here is the publication source. The workflow does **not** regenerate a
collection from OpenAPI — CORE already gates OpenAPI ↔ Postman conformance, and adding a second
generator here would create a second source of truth. Postman cloud is downstream of this
repository and never upstream of it.

## When it publishes

| Event | What runs |
|---|---|
| pull request touching a collection, the workflow or the scripts | validation only — parse, unit tests, secret-shape scan. No credential is available to the job and nothing is written to Postman. |
| push to `main` changing `paid-collection.json` or `onchainrisk_sandbox_api_collection.json` | validation, then publish — **only if `POSTMAN_AUTOPUBLISH_ENABLED` is exactly `true`**. |
| push to `main` changing anything else (README, CHANGELOG, integration docs, the workflow itself) | nothing. The publication trigger is path-filtered. |
| `workflow_dispatch` on `main` with `mode: verify` | read-only: reports `NOOP` or `UPDATE` per collection and writes nothing. |
| `workflow_dispatch` on `main` with `mode: publish` | publishes, same as a push, and equally gated on the activation variable. |

`pull_request_target` is deliberately not used, so no secret-bearing step ever runs against an
untrusted ref. Publication is serialized by a single concurrency group and is never cancelled
part-way — interrupting between the write and its verification would leave the remote state
unconfirmed.

## One-time configuration

A repository **secret**:

| Name | Value |
|---|---|
| `POSTMAN_API_KEY` | A Postman API key whose only needed right is updating the two collections below. Create it in Postman under Account Settings → API Keys. |

Three repository **variables** (Settings → Secrets and variables → Actions → Variables):

| Name | Value |
|---|---|
| `POSTMAN_PAID_COLLECTION_ID` | The Postman **cloud** id of "OnChainRisk Paid API" |
| `POSTMAN_SANDBOX_COLLECTION_ID` | The Postman **cloud** id of "OnChainRisk Sandbox API" |
| `POSTMAN_AUTOPUBLISH_ENABLED` | `true` to allow writing. Leave unset until the activation sequence below is complete. |

### Activation sequence

Nothing can be written while `POSTMAN_AUTOPUBLISH_ENABLED` is anything other than the exact
string `true` — not unset, not empty, not `false`, not `TRUE`, not `1`, not `yes`. The gate is
enforced twice: in the publish job's condition and again inside the script, so editing one does
not silently enable writes. The read-only `verify` dispatch stays available throughout, which is
how the real targets get inspected before anything is written:

1. merge this workflow to `main` with `POSTMAN_AUTOPUBLISH_ENABLED` **unset**;
2. configure `POSTMAN_API_KEY`, `POSTMAN_PAID_COLLECTION_ID`, `POSTMAN_SANDBOX_COLLECTION_ID`;
3. run **Actions → Publish Postman collections → Run workflow → mode: `verify`** against `main`;
4. read the output: both targets' asserted names, their identity fingerprints, the local and
   remote normalized hashes, and `ACTION` per collection. This is the first contact with the real
   cloud collections and it writes nothing;
5. only once that result is independently accepted, set `POSTMAN_AUTOPUBLISH_ENABLED=true`;
6. then authorize a `publish` dispatch, or let the next reviewed collection change publish.

> The `_postman_id` inside each checked-in file (`onchainrisk-paid-v3`,
> `onchainrisk-sandbox-v1`) is a collection-*document* identifier. It is **not** a cloud id, and
> the publisher will not guess one: an unset or wrong variable fails the run rather than
> discovering a same-named collection and writing to it.

To read a cloud id: open the collection in Postman → ⋯ → **Share** → **Via API**, or
`GET https://api.postman.com/collections` with the same key and match on `name`.

An `environment: postman` gate is declared on the publishing jobs, so a reviewer can require
approval for the credential in Settings → Environments if desired.

## What the run tells you

Before any write, for each collection, without secrets:

```
  role                 : paid
  source file          : paid-collection.json
  collection name      : OnChainRisk Paid API
  configured id        : len=13 sha256:6d784809 …d-id
  remote identity      : id len=36 sha256:… / uid len=45 sha256:…
  repository sha       : 49ec975c0b78
  local normalized sha : 9f53729038e773ea…
  remote normalized sha: 39d8014bccb87a66…
  request count (local): 46
  autopublish enabled  : no (POSTMAN_AUTOPUBLISH_ENABLED=(unset))
  ACTION               : UPDATE
```

The `remote identity` line reports the id and uid the API returned, fingerprinted the same way.

`ACTION = NOOP` means the remote already matches this repository and no write is issued — which
is the expected result right after a manual Postman update. After a write the run re-reads the
collection and reports `POSTMAN_REMOTE_MATCH_LOCAL = YES`; an HTTP 200 on its own is not treated
as success.

## The target is bound to the role

Before anything else, the run asserts that the collection it fetched is the one this role is
allowed to touch: the local file's name, the remote collection's name and a hard-coded
expectation must all agree, the remote must expose a usable identity, and the configured
variable must be a representation of that identity. Postman addresses a collection by `id` or by
the `{owner}-{id}` `uid`. When the remote returns **both**, only an exact match against one of
them passes — an earlier rule accepted anything ending in `-{id}`, which would have admitted a
uid carrying someone else's owner prefix. When only one form is returned, the other is derived
only where its syntax is provable: a uid yields its bare id by dropping the owner prefix, but an
id alone yields nothing, because an owner prefix cannot be invented.

So swapping the two variables fails instead of overwriting one collection with the other's
content, and an id pointing at some unrelated editable collection fails too. **The name is a
safety assertion, never a lookup** — no collection is ever searched for by name, no id is
substituted, and no configuration is repaired.

## How managed IDs are handled

Postman's full-collection replacement deletes and recreates any entity whose id is omitted,
which would churn the ids that deep links and attached resources depend on. Managed identity is
therefore modelled by POSITION, not by key name:

Two kinds are handled differently:

**Identity** — the handles Postman assigns. Normalized out of the comparison *and* preserved into
the outbound payload, because a replacement that omits an existing id makes Postman delete and
recreate that entity.

**Server metadata** — values the server generates *about* an entity: timestamps, ownership,
revision counters. Normalized out of the comparison and **never sent back**, because Postman
regenerates them on write; echoing them would be meaningless at best and a stale claim at worst.

| Entity | Identity (normalized + preserved) | Server metadata (normalized, never sent) |
|---|---|---|
| collection `info` | `_postman_id`, `postman_id`, `uid` | `owner`, `fork`, `createdAt`, `updatedAt`, `lastUpdatedBy`, `lastRevision` |
| collection top level | — | `_postman_exported_at`, `_postman_exported_using` |
| **collection-level `event`** | `id`, `_postman_id`, `postman_id` | — |
| **collection-level `event[].script`** | `id`, `_postman_id`, `postman_id` | — |
| folder / request | `id`, `uid`, `_postman_id`, `postman_id` | `createdAt`, `updatedAt` |
| response example | `id`, `uid`, `_postman_id`, `postman_id` | `createdAt`, `updatedAt` |
| item `event` | `id`, `_postman_id`, `postman_id` | — |
| item `event[].script` | `id`, `_postman_id`, `postman_id` | — |

A current GET returns `createdAt` / `updatedAt` on folders, requests and response examples as
well as on the collection. Neither checked-in collection carries them structurally — the four
`createdAt` strings in the paid collection are inside response-example *bodies*, which is our
content — so before they were modelled, every ordinary GET differed from the canonical file
purely by server timestamps: a false `ACTION=UPDATE`, and then a post-write verification that
could never match, because the verifying GET added them again. Timestamps are deliberately *not*
modelled on events or scripts, where the API does not return them.

Each field is listed only where it is deliberately treated as managed. v2.1 documents `id` on
event and script objects and the PUT documentation cites `postman_id`, but neither the schema nor
any response modelled here carries a `uid` at those positions, so `uid` is **not** normalized
there — a `uid` appearing on an event is treated as content, and changing it is real drift. The
same reasoning keeps timestamps off event and script positions.

That is the safe direction to err: an unmodelled managed field surfaces as a loud failure and a
refused run, whereas normalizing a field Postman does not own would silently hide a content
change. Nothing is stripped by property name alone — a request body, a header, a collection
variable or a `request` object containing `id`, `uid`, `postman_id`, `createdAt` or `updatedAt`
keeps it, and a change to it is detected as real drift.

Collection v2.1 allows **root-level events** — collection-wide prerequest/test scripts — and the
API returns managed ids on them exactly as it does on an item's events. They are matched by
`listen`, like any other event list. Omitting those positions would have meant false drift,
script-id churn and a post-write mismatch the first time a collection-wide script appeared.

**`_postman_id` vs `postman_id`.** The API uses both spellings depending on position and
endpoint — the export carries `info._postman_id`, while the PUT documentation also refers to
managed `id`, `uid` and `postman_id` values on structural entities. Both spellings are listed at
every managed position, and *only* there: a request body or a collection variable that happens to
contain `"postman_id": "business-data"` keeps it, and that value is part of the content hash, so
changing it is detected as real drift.

A recursive "delete anything called `id`" would also erase an `id` inside a request body or a
response example — that is our content, and a change to it must surface rather than be
normalized away.

The outbound payload starts from the local content with **every local managed id stripped**, so a
stale id in a checked-in file cannot leak into a replacement, and then the remote's identities
are injected where the match is unambiguous. Matching is by stable identity: full ancestry for
folders, ancestry plus method plus normalized path for requests, example name for responses, and
`listen` for events and their scripts.

Only ids cross over. No remote description, script body, variable, auth value, header or example
body is ever copied back — the local file stays the content authority. A new local entity is sent
with no id so Postman mints one; an entity removed locally stays removed; two items sharing a
stable identity abort the run; and an ambiguous response-example or event name deliberately omits
just that sub-entity's id, so Postman recreates it rather than having an id guessed for it.

Ambiguity is checked on **both** sides, by one shared helper, and the decision is made from
structural multiplicity alone — before any identity is looked at. Whether an occurrence happens
to carry an id, whether only one of two events has a script, and what order the list is in are
all irrelevant: a key appearing twice yields no mapping at all. A duplicated key in the *local*
file also blocks assignment, since otherwise one remote id for `listen: "test"` would be written
onto two local events that both declare it, which is never valid.

Collection-level identity is restored in whichever representations the remote actually supplied —
`_postman_id`, `postman_id`, `uid` — using the exact remote values. A collection whose identity
comes back only as `info.postman_id` round-trips with that field intact and nothing invented
alongside it.

## Failure behaviour

Every one of these fails the run, with no retry against a different endpoint and no
create-new-collection fallback: a missing key, a missing collection-id variable, a target whose
name is not this role's expectation, a configured id inconsistent with the identity the remote
returned, a remote with no usable identity, any non-2xx from Postman, a duplicated item identity
in either collection, a failed re-read, a post-write comparison that still differs from the local
file, or a required write while `POSTMAN_AUTOPUBLISH_ENABLED` is not `true`.

## Running it locally

```bash
# no credential needed: parses both collections and checks identity uniqueness
node .github/scripts/postman-sync.mjs --selftest

# the unit tests (local fixtures and the two real collections; no network)
node --test ".github/scripts/test/*.test.mjs"
```

`--verify` and `--publish` need `POSTMAN_API_KEY` plus both id variables in the environment.
Prefer running those through the workflow, so the credential stays in Actions secret storage.
