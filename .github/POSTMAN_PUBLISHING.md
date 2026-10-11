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
| push to `main` changing `paid-collection.json` or `onchainrisk_sandbox_api_collection.json` | validation, then publish. |
| push to `main` changing anything else (README, CHANGELOG, integration docs, the workflow itself) | nothing. The publication trigger is path-filtered. |
| `workflow_dispatch` on `main` with `mode: verify` | read-only: reports `NOOP` or `UPDATE` per collection and writes nothing. |
| `workflow_dispatch` on `main` with `mode: publish` | publishes, same as a push. |

`pull_request_target` is deliberately not used, so no secret-bearing step ever runs against an
untrusted ref. Publication is serialized by a single concurrency group and is never cancelled
part-way — interrupting between the write and its verification would leave the remote state
unconfirmed.

## One-time configuration

A repository **secret**:

| Name | Value |
|---|---|
| `POSTMAN_API_KEY` | A Postman API key whose only needed right is updating the two collections below. Create it in Postman under Account Settings → API Keys. |

Two repository **variables** (Settings → Secrets and variables → Actions → Variables):

| Name | Value |
|---|---|
| `POSTMAN_PAID_COLLECTION_ID` | The Postman **cloud** id of "OnChainRisk Paid API" |
| `POSTMAN_SANDBOX_COLLECTION_ID` | The Postman **cloud** id of "OnChainRisk Sandbox API" |

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
  repository sha       : 49ec975c0b78
  local normalized sha : 9f53729038e773ea…
  remote normalized sha: 39d8014bccb87a66…
  request count (local): 46
  ACTION               : UPDATE
```

`ACTION = NOOP` means the remote already matches this repository and no write is issued — which
is the expected result right after a manual Postman update. After a write the run re-reads the
collection and reports `POSTMAN_REMOTE_MATCH_LOCAL = YES`; an HTTP 200 on its own is not treated
as success.

## How IDs are handled

Postman's full-collection replacement deletes and recreates any item whose id is omitted, which
would churn the request and folder ids that deep links and attached resources depend on. So the
publisher fetches the remote collection and injects the existing ids into the outgoing copy,
matching by stable identity: full folder ancestry for folders, and ancestry plus method plus
normalized path for requests.

Only ids cross over. No remote description, script, variable, auth value, header or example body
is ever copied back — the local file stays the content authority. A new local item is sent with
no id so Postman mints one; an item removed locally stays removed; and if two items share a
stable identity the run aborts rather than guessing which id belongs to which.

## Failure behaviour

Every one of these fails the run, with no retry against a different endpoint and no
create-new-collection fallback: a missing key or collection-id variable, any non-2xx from
Postman, a duplicated or ambiguous identity in either the local or the remote collection, a
failed re-read, or a post-write comparison that still differs from the local file.

## Running it locally

```bash
# no credential needed: parses both collections and checks identity uniqueness
node .github/scripts/postman-sync.mjs --selftest

# the unit tests (local fixtures and the two real collections; no network)
node --test ".github/scripts/test/*.test.mjs"
```

`--verify` and `--publish` need `POSTMAN_API_KEY` plus both id variables in the environment.
Prefer running those through the workflow, so the credential stays in Actions secret storage.
