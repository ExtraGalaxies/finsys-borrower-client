# Changelog

All notable changes to `@finsys/borrower-client` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries start at 3.11.0 — the release that introduced this file. Earlier
versions are described by their GitHub Releases.

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
