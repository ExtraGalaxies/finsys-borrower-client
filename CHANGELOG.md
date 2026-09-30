# Changelog

All notable changes to `@finsys/borrower-client` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries start at 3.11.0 — the release that introduced this file. Earlier
versions are described by their GitHub Releases.

## [Unreleased] - 4.0.0

### Removed

- **`endpointOverrides` (SYS-3769).** It let a consumer point some calls at one host while the
  rest fell back to the built-in default. lead-gen did that by accident: FinSim and local runs
  sent consent events to prod. The constructor now throws if `endpointOverrides` is passed.

### Added

- **`baseUrl` (SYS-3769).** Pass `baseUrl` (any finsys-api origin) or `environment` (a built-in
  host), not both. `null` counts as not set. Every call goes to that one origin, which the
  read-only `client.baseUrl` exposes. The constructor throws if both or neither are set, if
  `baseUrl` isn't a bare http(s) origin, or if `environment` isn't `staging` or `production`.
  Plain `http` is accepted only for a local host: `localhost`, a loopback address, or a
  one-word name such as `finsys-api`.
- **`normalizeBaseUrl()`** returns a configured URL as a bare origin, or throws. Consumers call
  it at startup.

### Changed

- **The constructor throws on a bad config (SYS-3769).** 3.x accepted any config and failed
  later, when a call returned `{ success: false }`. A client built when a module loads, from a
  mistyped env var, now throws on import.
- **`BorrowerClientConfig` is a type, not an interface (SYS-3769).** It is now
  `BorrowerTarget & { credentials }`. `interface X extends BorrowerClientConfig` no longer
  compiles, and `Partial<>` or `Omit<>` over it lose the "one target" rule. Build your own
  types from `BorrowerTarget` and `BorrowerClientConfig['credentials']`.
- **`BASE_URLS` and `ENDPOINT_PATHS` are frozen (SYS-3769).** Changing them at runtime throws.

### Migrating from 3.x

Replace `endpointOverrides` with `baseUrl` set to the origin the overrides pointed at, for
example `baseUrl: 'http://finsys-api:8006'`. Consumers that only pass `environment` need no
change.

## [3.12.0] - 2026-09-23

### Added

- **Route the `experian_report` and `management_account` upload fields to
  extraction (SYS-3706).** `@finsys/core` 9.4.0 adds two document types
  (`experianReports`, `managementAccounts`). Without a document pattern their
  file fields fell through to `supplementaryDoc`: the file was stored but
  never extracted.
- **Release only with finsys-api support.** finsys-api must accept the
  `experianReports` / `managementAccounts` fields (SYS-3675, SYS-3703) before
  this ships; until then an upload under the new keys is not stored at all,
  which is worse than the `supplementaryDoc` fallback it replaces.

### Changed

- **The payload contract test now checks file fields route as documents.**
  The existing check only asserted that every base-field-spec name resolves
  to *some* rule, and every name does (as an `ihs_column`), so it passed for
  the two new file fields while they fell through to `supplementaryDoc`. Each
  `type: 'file'` spec must now resolve to `kind: 'document'` with `apiField`
  equal to its declared `document_type` and `format` equal to its
  `wire_format`.

## [3.11.0]

### Changed

- **`@finsys/core` peer widens from `>=2.0.0 <9` to `>=2.0.0 <10` (SYS-3555).**
  The old ceiling refuses `@finsys/core@9.x` with `ERESOLVE`, so any consumer
  moving to core 9 could not install this package at all. This is the same
  failure SYS-3420 fixed for core 8 — where it took down finhub-adonisjs's
  image build — arriving again one major later, and for the same reason: the
  ceiling was written as the next unreleased major rather than as a statement
  about what this package actually needs.

  Measured rather than assumed: `tsc --noEmit` is clean and all 120 tests pass
  against core `8.1.2` and against the `9.0.0` candidate. Core 9 changed no
  field and no category this package reads.

- **The `@finsys/core` devDependency moves from `^7.8.0` to `^8.1.2`.** A
  package whose peer range admits three majors is only ever compiled against
  one of them, and this one was a major behind everything that consumes it —
  so the range's top half was never exercised. It should move to `^9.x` once
  core 9.0.0 publishes, per SYS-3380's "the devDependency is the half that
  matters".

### Added

- **This file.** The shared publish workflow's preflight requires a changelog
  entry for the version being released, and refuses the publish without one.
  This package had no `CHANGELOG.md` at all, which was invisible only because
  the workflow pin predated that check.
