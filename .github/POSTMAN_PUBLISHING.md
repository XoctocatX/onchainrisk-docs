# Postman publishing

How the three published artifacts in this repository reach Postman cloud, and what a maintainer
has to configure once before the first publish.

**ONE collection, used with EITHER of two environments.** The credential is the only thing that
changes between tiers — same requests, same paths, same bodies, same client code:

| Target | File | Name in Postman |
|---|---|---|
| collection | `onchainrisk_api_collection.json` | `OnChainRisk API` |
| environment | `production.postman_environment.json` | `OnChainRisk Production` |
| environment | `sandbox.postman_environment.json` | `OnChainRisk Sandbox` |

Each of the three is an **independently verifiable target**: its own configured id, its own
remote identity, its own local and remote normalized hash, and its own `ACTION`. A write to one
never implies a write to another, and a `verify` run writes nothing at all.

> This replaced two per-tier collections. That design stated that paid and sandbox are two
> different integrations; they are one integration with two credentials. The old sandbox **cloud**
> collection is retained and deprecated rather than deleted — people may have imported or forked
> it — and this publisher does not touch it. Retiring it is a separate, bounded write.

## What publishes, and from where

```
XoctocatX/onchainrisk (canonical)
  -> production served artifacts at api.onchainrisk.io
    -> this mirror  (onchainrisk_api_collection.json,
                     production.postman_environment.json,
                     sandbox.postman_environment.json)
      -> Postman cloud
```

The checked-in JSON here is the publication source. The workflow does **not** regenerate a
collection from OpenAPI — CORE already gates OpenAPI ↔ Postman conformance, and adding a second
generator here would create a second source of truth. Postman cloud is downstream of this
repository and never upstream of it.

## When it publishes

| Event | What runs |
|---|---|
| pull request touching a published artifact, the workflow or the scripts | validation only — parse, unit tests, secret-shape scan. No credential is available to the job and nothing is written to Postman. |
| push to `main` changing the collection or either environment file | validation, then publish — **only if `POSTMAN_AUTOPUBLISH_ENABLED` is exactly `true`**. |
| push to `main` changing anything else (README, CHANGELOG, integration docs, the workflow itself) | nothing. The publication trigger is path-filtered. |
| `workflow_dispatch` on `main` with `mode: verify` | read-only: reports `NOOP` or `UPDATE` **per target** and writes nothing. |
| `workflow_dispatch` on `main` with `mode: publish` | publishes, same as a push, and equally gated on the activation variable. |

`pull_request_target` is deliberately not used, so no secret-bearing step ever runs against an
untrusted ref. Publication is serialized by a single concurrency group and is never cancelled
part-way — interrupting between the write and its verification would leave the remote state
unconfirmed.

## One-time configuration

A repository **secret**:

| Name | Value |
|---|---|
| `POSTMAN_API_KEY` | A Postman API key whose only needed rights are updating the three targets below — the canonical collection and the two environments — and nothing else. Create it in Postman under Account Settings → API Keys. |

Three repository **variables** (Settings → Secrets and variables → Actions → Variables):

| Name | Value |
|---|---|
| `POSTMAN_COLLECTION_ID` | The Postman **cloud** id of `OnChainRisk API` |
| `POSTMAN_PRODUCTION_ENVIRONMENT_ID` | The Postman **cloud** id of `OnChainRisk Production` |
| `POSTMAN_SANDBOX_ENVIRONMENT_ID` | The Postman **cloud** id of `OnChainRisk Sandbox` |
| `POSTMAN_AUTOPUBLISH_ENABLED` | `true` to allow writing. Leave unset until the activation sequence below is complete. |

(Four variables, not three — the activation switch is the fourth.)

### Activation sequence

Nothing can be written while `POSTMAN_AUTOPUBLISH_ENABLED` is anything other than the exact
string `true` — not unset, not empty, not `false`, not `TRUE`, not `1`, not `yes`. The gate is
enforced twice: in the publish job's condition and again inside the script, so editing one does
not silently enable writes. The read-only `verify` dispatch stays available throughout, which is
how the real targets get inspected before anything is written:

1. merge this workflow to `main` with `POSTMAN_AUTOPUBLISH_ENABLED` **unset**;
2. configure `POSTMAN_API_KEY`, `POSTMAN_COLLECTION_ID`, `POSTMAN_PRODUCTION_ENVIRONMENT_ID` and
   `POSTMAN_SANDBOX_ENVIRONMENT_ID`;
3. run **Actions → Publish Postman artifacts → Run workflow → mode: `verify`** against `main`;
4. read the output: all **three** targets' asserted names, their identity fingerprints, the local
   and remote normalized hashes, and `ACTION` per target. This is the first contact with the real
   cloud objects and it writes nothing — the run also reports `WRITES_ISSUED = 0`;
5. only once that result is independently accepted, set `POSTMAN_AUTOPUBLISH_ENABLED=true`;
6. then authorize a `publish` dispatch, or let the next reviewed change to a published artifact
   publish.

> **No checked-in file carries a cloud id.** The three ids above exist only as repository
> variables. The generated collection carries no `info._postman_id` whatsoever — the cloud id and
> `uid` live only on the remote, and the publisher copies the REMOTE identity into the payload it
> writes so a PUT preserves the cloud document instead of replacing it. Each environment does
> carry a top-level `id` (`onchainrisk-production`, `onchainrisk-sandbox`), but that is a
> human-readable *document* identifier: comparison drops it, and the PUT substitutes the
> configured cloud id. So a wrong variable cannot be rescued by the file's own id — and the
> publisher will not guess one, nor create one. An unset or wrong variable fails the run rather
> than discovering a same-named object and writing to it. There is no create path for any of the
> three targets.

To read a cloud id: open the collection or environment in Postman → ⋯ → **Share** → **Via API**,
or `GET https://api.postman.com/collections` and `GET https://api.postman.com/environments` with
the same key and match on `name`.

An `environment: postman` gate is declared on the publishing jobs, so a reviewer can require
approval for the credential in Settings → Environments if desired.

## What the run tells you

Before any write, for **each of the three targets**, without secrets:

```
  role                 : collection
  source file          : onchainrisk_api_collection.json
  collection name      : OnChainRisk API (asserted on both sides)
  configured id        : len=36 sha256:6d784809 …d-id
  remote identity      : id len=36 sha256:… / uid len=45 sha256:…
  repository sha       : 7825a07c4f91…   <- THIS mirror's GITHUB_SHA, not a CORE sha
  local normalized sha : 21da25ef0fccbc96…
  remote normalized sha: 39d8014bccb87a66…
  request count (local): 45
  autopublish enabled  : no (POSTMAN_AUTOPUBLISH_ENABLED=(unset))
  ACTION               : UPDATE
```

and for an environment the same block, with the two per-kind lines differing:

```
  role                 : sandbox-environment
  kind                 : environment
  source file          : sandbox.postman_environment.json
  environment name     : OnChainRisk Sandbox (asserted on both sides)
  ...
  variables (local)    : 15 — base_url, api_key, tier, sample_address, sample_network, …
  ACTION               : NOOP
```

A `verify` run closes with `WRITES_ISSUED = 0`, stated rather than left to be inferred.

The `remote identity` line reports the id and uid the API returned, fingerprinted the same way.

`ACTION = NOOP` means the remote already matches this repository and no write is issued — which
is the expected result right after a manual Postman update.

On `ACTION = UPDATE` the run additionally prints a **safe structural diff**, so a reviewer can
answer "what would change if we publish?" before approving a write:

```
  diff summary (paths only — no values, no ids, no bodies):
    added   : 2
    removed : 3
    changed : 4

    changed paths:
      info.description
      item[Analysis].item[POST /api/v1/check].request.description
      item[Analysis].item[POST /api/v1/check].event[test].script.exec
```

It reports **paths and categories only**. No old or new value, no request or response body, no
header or variable value, no id or uid, no hash beyond the two normalized SHAs already shown.
`ADDED` means publishing would create it, `REMOVED` that publishing would delete it — the local
file is the target state.

Selectors are semantic where a stable identity exists: folder name, request method plus
normalized path, example name, event `listen`, header and variable key. Positional indexes are
used only where neither side has a usable identity, and the strategy is chosen once for the pair
so one edit never reads as an unrelated add plus remove. The incident that prompted that rule:
the hand-authored paid collection carried two events with `listen: "test"` on one request, so a
remote with a single `test` event reported both an add and a remove for one edit. The generated
collection emits exactly one test event per scripted request, so nothing published is un-keyable
today — the pair-wise rule stays because Postman can return that shape at any time.

**Every** externally-derived path component goes through one safety policy — folder and request
names, the HTTP method, each URL path segment, example names, event `listen`, header / variable /
query keys, and object property keys. Nothing relies on a caller remembering to call it.

- anything secret-shaped (a Postman API key, an `ocr_live_`/`ocr_test_` key, a JWT, a
  `Bearer …` header, a long hex or base64 blob) becomes a short deterministic fingerprint. Each
  shape is tested against three canonical forms — the raw text, the text with control characters
  removed, and with them turned into spaces — so a credential split by a tab cannot slip past
  the detector while two genuinely separate words stay readable;
- control characters — C0, DEL, C1 and the Unicode line separators — are replaced with a visible
  placeholder, so a name cannot forge a log line or emit a terminal escape;
- an over-long component keeps its readable prefix and gains both its true length and a
  fingerprint of the whole value. The fingerprint is not cosmetic: a rendered label is also a
  semantic array selector, and without it two labels sharing their first 80 characters and their
  total length collapsed into one selector — pairing two distinct folders and turning a real
  remove-plus-add into a misleading nested `CHANGED`;
- an HTTP method renders literally only if it is on an explicit allowlist (the HTTP verbs plus
  the WebDAV ones Postman offers). Anything else becomes `<method sha256:…>`; a shape test is not
  enough, because an odd-but-not-secret method would otherwise be echoed;
- a URL path is sanitised segment by segment, so one bad segment is redacted on its own and
  `POST /api/v1/check` stays readable;
- property keys from the Collection v2.1 schema render literally, and any other key is
  fingerprinted — an extension field's *name* can itself be sensitive, and the renderer must not
  decide that by looking at it.

Every line the formatter emits is exactly one line, so "no control character in any emitted
line" is a property the caller can rely on. A test asserts that a realistic diff of the shipped
collection contains no fingerprinted component at all, so readability is not traded away to
satisfy the safety rules.

It is diagnostic only: it reads the two already-normalized documents of a pair and changes
nothing about target binding, normalization, identity preservation, ambiguity handling, the
activation gate, the payload or post-write verification. `ACTION = NOOP` prints no diff section at all. After a write the run re-reads the
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
| response example | `id`, `uid`, `_postman_id`, `postman_id` | `createdAt`, `updatedAt`, `responseTime` |
| item `event` | `id`, `_postman_id`, `postman_id` | — |
| item `event[].script` | `id`, `_postman_id`, `postman_id` | — |

A current GET returns `createdAt` / `updatedAt` on folders, requests and response examples as
well as on the collection. The checked-in collection carries none of them structurally, so
before they were modelled, every ordinary GET differed from the canonical file purely by server
timestamps: a false `ACTION=UPDATE`, and then a post-write verification that could never match,
because the verifying GET added them again.

The table is **per position** rather than a flat denylist, and that distinction has a history:
back when the paid collection was hand-authored it carried four `createdAt` strings inside
response-example *bodies*, which is our content and must survive normalization. The generated
collection has no saved examples, so it carries none today — but a flat "delete anything called
`createdAt`" would be wrong the moment one returns, and the position-aware behaviour is proven
on a synthetic collection in the test suite rather than on whatever the published file happens
to contain. Timestamps are deliberately *not*
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

### Postman's serialization of optional fields

Two further differences are Postman's *serializer*, not managed identity, and they are
canonicalized for comparison only — in `normalizeForCompare`, never in `stripManaged`, so the
outbound PUT body is unaffected. Nothing is injected and no array is added on the way out.

`responseTime` is the latency Postman recorded when a response example was captured: a fact
about one historical send, not about the contract. It is modelled at the response-example
position and nowhere else, so a `responseTime` on an item, on a `request`, inside an example
*body*, or in any nested business object stays content and changing it is real drift.

`response: []` is what Postman writes on a request with no saved examples, where a hand-authored
collection simply omits the optional field. Both state "no saved examples", so an absent
`response` and an empty one compare equal. The rule is narrow in three ways: it applies at the
request-item position only, it drops only a zero-length array — a non-empty `response` is
authored content and participates in the comparison and the hash in full — and it only ever
removes an empty array, never adds one.

Together these were every remaining difference after the first real write: the paid collection
then held 39 requests with no authored examples plus 19 saved examples, which is exactly the 58
paths the post-write verification reported before it correctly stopped. The generated collection
has a simpler shape — 45 requests, every one with a generated empty `response` array and no saved
examples — so that arithmetic is history; the incident is preserved as a decoupled test fixture
rather than re-derived from a live file.

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
in the local or remote document, a failed re-read, a post-write comparison that still differs
from the local file, or a required write while `POSTMAN_AUTOPUBLISH_ENABLED` is not `true`.
For an environment, additionally: a local or remote name that is not that role's expectation, a
duplicate variable key, or a document that is neither a collection (`info.name` + `item[]`) nor
an environment (`name` + `values[]`).

## Running it locally

```bash
# no credential needed: parses all three targets, checks identity uniqueness, and asserts the
# drop-in invariant — the two environments declare the SAME variable names, and no artifact
# references a tier-named credential variable. The only credential variable is `api_key`.
node .github/scripts/postman-sync.mjs --selftest

# the unit tests (local fixtures and the three real artifacts; no network)
node --test ".github/scripts/test/*.test.mjs"
```

`--verify` and `--publish` need `POSTMAN_API_KEY` plus all three id variables in the environment.
Prefer running those through the workflow, so the credential stays in Actions secret storage.
