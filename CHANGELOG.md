# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- audit-cycle R6-R10: 80 agents, 220+ findings, 70+ fixes shipped across V4 engine, Python executor, V231 router, storage, AI, React UX, auth, CI/CD.
- R9 gap-fix audit-trail: pass-lock close-all-on-target-reached gap closed (open-position MTM realised at window end no longer leaks past Pass-Lock fire).
- R28_V6_PASSLOCK champion (63.24% V4-Engine pass-rate full 136-window aggregate, +6.62pp vs R28_V6 56.62% baseline).
- 3-Strategy Multi-Account deploy guide (`tools/MULTI_STRATEGY_SETUP.md`, `tools/start-3-strategy.sh`, `tools/ecosystem-multi.config.js`).
- PASSLOCK live deploy runbook (`tools/PASSLOCK_DEPLOY_RUNBOOK.md`).

### Changed

- Test suite: 911 → 1049+ vitest, 111 → 153+ pytest.
- Drift Dashboard `BACKTEST_REF` recalibrated to PASSLOCK 64.77% / 63.24%.
- News-Blackout activated by default in `.env.ftmo.*.example` templates.

## 0.1.1 - 2026-02-28

### Added

- CI `e2e` job (Playwright) for pull requests and pushes to `main`.
- Dependabot auto-merge automation for semver patch/minor updates.

### Changed

- Upgraded key dependencies (including Next.js 16, `uuid` 13, and `@supabase/supabase-js` 2.98.0).
- Strengthened CI/security gating with required status checks.
