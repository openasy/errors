# errors

[![CI](https://github.com/openasy/errors/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/errors/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Errors product: application errors grouped into **issues**, with stack
traces, releases, the people they hit, and **regressions** when a fix did not hold (ADR 0042). Applications send
events with one HTTP request; no SDK is needed.

```
application ──POST /api/v1/events, x-errors-key──▶ errors  ──▶  issue: 214 events, 38 users, first seen in 1.4.2
                                                    └── resolve in 1.4.3; if it comes back, it reopens as a regression
```

## Send an event

Add a project under Projects and copy its key (shown once, kept only as a hash). Then:

```bash
curl -sf -X POST https://errors.example.com/api/v1/events -H "x-errors-key: $ERRORS_KEY" -H 'content-type: application/json' -d '{
  "release": "1.4.2", "environment": "production", "user": {"id": "u-42"},
  "exception": {
    "type": "TypeError", "value": "x is undefined",
    "frames": [{"filename": "src/cart.js", "function": "total", "lineno": 12, "in_app": true}]
  }
}'
```

The key can also be a bearer token. The body may be gzipped (`Content-Encoding: gzip`), up to 1 MiB unpacked. The
schema is in the [API reference](http://localhost:8080/api/docs/): `message`, `exception` (`type`, `value`, `frames` with
the most recent call last), `level`, `timestamp`, `release`, `environment`, `user.id`, `tags`, `request` (`url` and
`method`) and `fingerprint`.

## How events become issues

- Events with the same **exception type** and the same **last three frames of your own code** (`in_app: true`; file and
  function, never line numbers) are one issue, so a deploy that moves code does not split it. With no frames, the
  message is compared with its numbers, hex values, UUIDs and quoted text ignored. Send `fingerprint` to decide yourself.
- An issue keeps its first and last time, how many events and **how many distinct users** it hit, the releases and
  environments it appeared in, and its **latest 20 events** with their stack traces. Older events are counted and dropped.
- **Resolve** an issue, optionally with the release that ships the fix. If it happens again, in any release, it
  reopens as a **regression**; the page reads "fix meant for 2.1.0, came back in 2.2.0". **Ignore** keeps an issue quiet
  however often it happens.
- **Releases** are learned from events: when each was first seen and how many new issues it brought.

## What is not kept

Request bodies, headers and cookies are not accepted: an event that holds them is refused, so a mistake in an SDK
cannot start a leak. `request` keeps the address without its query string and the method. `user` holds only an id.
Passwords, tokens and keys in messages, exception values and tags are masked before anything is stored; tags whose name
looks like a secret are replaced.

## Run

```bash
openssl rand -hex 32 > openasy-kek
docker compose up -d
docker compose logs errors | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080. `openasy-kek` encrypts sign-in secrets in the database (ADR 0021): keep it apart from the
volume and with your backups.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `ERRORS_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `ERRORS_RATE_LIMIT` | `600` | Events a minute a project may send, unless it has its own limit. Over it: 429 with `Retry-After`, and the event is not stored |
| `ERRORS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `ERRORS_DB` | `/data/errors.db` | SQLite file (WAL), on the `/data` volume |
| `ERRORS_RETENTION_DAYS` | `90` | Issues with no event for this long, and events older than it, are deleted |
| `ERRORS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `ERRORS_HEADLESS` | `false` | `true` serves only the API |
| `ERRORS_PASSWORD_SIGN_IN`, `ERRORS_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)). Owners can also add identity providers under Settings, Sign-in |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. The rate
limit counts in memory: a restart gives every project a fresh minute.

## Roles

Viewers see everything; editors also resolve, ignore and reopen issues; admins also add, change and delete projects,
replace their keys, delete issues, and manage members and API tokens (ADR 0003). Applications use project keys, which
can send events and nothing else.

## Develop

```bash
npm install
npm test        # event schema, grouping, regressions, the rate limit, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
