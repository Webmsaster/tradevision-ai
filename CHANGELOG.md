# Changelog

All notable changes to this project are documented in this file.

## [0.2.0](https://github.com/Webmsaster/tradevision-ai/compare/v0.1.1...v0.2.0) (2026-03-05)


### Features

* add JSON restore modes and smoke failure alerts ([f8e9aff](https://github.com/Webmsaster/tradevision-ai/commit/f8e9aff8de8c763b9edc9392fd963cf3b880104f))
* **ci:** add scheduled production smoke checks ([06587e2](https://github.com/Webmsaster/tradevision-ai/commit/06587e217b31943af6ee1a685195d6a9bf5038d3))


### Bug Fixes

* **ci:** use env values in smoke alert conditions ([251dae1](https://github.com/Webmsaster/tradevision-ai/commit/251dae11390e54a73cc70154ce46321e7868232c))
* detect placeholder Supabase URL in CI for login-flow E2E tests ([8ec0927](https://github.com/Webmsaster/tradevision-ai/commit/8ec0927fa662f0edf5b0cf25237e7d97acae3f6c))
* harden error handling, accessibility, and add E2E coverage ([d0110a5](https://github.com/Webmsaster/tradevision-ai/commit/d0110a5cc34a840a343cc103367513da8301bd5b))
* harden settings validation and add parseInt radix ([c655e52](https://github.com/Webmsaster/tradevision-ai/commit/c655e528fa2888b7eca317829990b4bd36e23e95))

## 0.1.1 - 2026-02-28

### Added
- CI `e2e` job (Playwright) for pull requests and pushes to `main`.
- Dependabot auto-merge automation for semver patch/minor updates.

### Changed
- Upgraded key dependencies (including Next.js 16, `uuid` 13, and `@supabase/supabase-js` 2.98.0).
- Strengthened CI/security gating with required status checks.
