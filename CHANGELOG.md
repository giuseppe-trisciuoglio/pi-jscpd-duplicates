# Changelog

All notable changes to this project will be documented in `CHANGELOG.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-01

### Added

- Initial release.
- Automatic mode: when the agent writes or edits a source file, a debounced jscpd scan of the project runs in the background; at the end of the turn, clones that involve at least one freshly written file are reported to the agent with a single continuation so it can refactor while the context is still warm.
- Manual command `/jscpd [minTokens]`: synchronous full project scan and a turn-triggered report to the agent.
- Double defense against non-first-party paths: explicit `--ignore` patterns for jscpd plus a post-parse segment filter that drops clones whose either side contains a junk segment (`.git`, `node_modules`, `dist`, ...).
- Header-only clone filter: clones whose only content is imports/comments/blank lines are dropped before reporting, so two test files importing the same symbols do not produce a false positive.
- `:format` suffix normalization in jscpd file names (`CHANGELOG.md:markdown` → `CHANGELOG.md`), so path matching in automatic mode does not fail silently.
- Loop guards: at most 2 refactor rounds per conversation chain, and a no-op refactor (identical clone-set signature round) does not trigger a second round.
- User notification on every relevant outcome, even when continuation is suppressed.
- Pure `scan.ts` with no pi dependency: mapping extensions to formats, JSON report parsing, clone filtering, signature computation, message formatting.
- Unit tests on `scan.ts` (`npm run test:unit`): format mapping, JSON parsing, clone filtering, signature stability, message formatting, header-only detection.