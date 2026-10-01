# pi-jscpd-duplicates

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that keeps AI-generated code free of duplicate blocks. Every time the agent writes or edits a source file, a [jscpd](https://github.com/kucherenko/jscpd) scan of the project runs in the background; if the freshly written code duplicates existing code, the agent receives a concise refactor brief and one continuation at the end of the turn.

## Why

LLMs tend to repeat themselves: a method defined twice in two files, a helper re-implemented per page, near-identical test boilerplate. Code review catches it, often after the fact. This extension catches it as the code is being written and asks the agent to refactor while the context is still warm.

## How it works

```
write/edit ──▶ tool_result ──▶ debounce 3s ──▶ jscpd in background (npx)
                                                       │
agent finishes ──▶ agent_before_settle ──▶ waits for the result
                                                       │
                              any clone involving the freshly written files?
                                                       │
                            no ──▶ done             yes ──▶ notify the user
                                                              + one message to the agent
                                                              + continue: true
                                                              (max 2 rounds per chain)
```

- **Never blocks the write**: jscpd runs as a separate process (`npx jscpd`) that starts while the agent is still working; the result is normally ready by the time the turn ends.
- **Only reports new duplication**: clones that involve at least one file written in the current turn. Pre-existing duplication the agent never touched is left alone.
- **One consolidated report per turn** (`agent_before_settle`): a burst of writes and edits collapses into a single scan (debounce) and a single report.
- **Loop-proof**: at most 2 refactor rounds per conversation chain (`agent_settled` resets the counter), and if the clone set signature is identical to the previous round (the refactor changed nothing) no second round is offered.
- **Always notifies the user** (`ui.notify`), even when continuation is suppressed (turn aborted, cap reached, no-op refactor).
- The JSON report is written to a temp directory outside the project so jscpd never scans its own report as a source.

## Install

```bash
pi install git:github.com/giuseppe-trisciuoglio/pi-jscpd-duplicates
# or from npm:
pi install npm:@giuseppe.trisciuoglio/pi-jscpd-duplicates
# or from a local checkout:
pi install /path/to/pi-jscpd-duplicates
# or try without installing:
pi -e /path/to/pi-jscpd-duplicates/src/index.ts
```

`npx` must be available on the host; jscpd is downloaded from the npm cache on first use (a one-off cost of a few seconds).

## Usage

- **Automatic**: no action required. Write code with the agent; if it introduces duplication, the agent receives the report and refactors.
- **Manual**: `/jscpd [minTokens]` — full project scan (all jscpd-supported formats) with an immediate report to the agent.

## Configuration

Tunables in `src/index.ts` (move to settings if needed):

| Constant              | Default | Meaning                                                              |
| --------------------- | ------- | -------------------------------------------------------------------- |
| `MIN_TOKENS`          | 50      | jscpd token threshold for considering a block duplicated              |
| `DEBOUNCE_MS`        | 3000    | wait after the last write/edit before launching the scan                |
| `SCAN_TIMEOUT_MS`    | 90000   | scan timeout                                                |
| `MAX_REFACTOR_ROUNDS` | 2      | max refactor continuations per conversation chain                     |

## Supported formats

typescript, javascript, python, java, swift, go, rust, ruby, php, csharp,
scala, c, cpp, bash, kotlin. Other jscpd formats are scanned only by the
manual `/jscpd` command (which does not filter by extension).

## Architecture

```
src/
  index.ts   # pi integration: tool_result, agent_before_settle, agent_settled,
             # session_shutdown, /jscpd command
  scan.ts    # pure, decoupled logic, unit-tested. Maps file extensions to
             # jscpd formats, parses the JSON report, filters relevant
             # clones, formats the report. The sole injected external is an
             # `exec` function.
test/
  scan.test.ts            # vitest unit tests on scan.ts
  pi-coding-agent-stub.ts # vitest alias target so src files referencing the
                          # pi host type resolve under the test runner
```

`scan.ts` is pure: it does not import any pi symbol, so its tests need no
host runtime. The `pi-coding-agent-stub.ts` exists so a future test that
imports `src/index.ts` still resolves `@earendil-works/pi-coding-agent`
under vitest's strict resolver.

## Design notes

1. **Debounce + end-of-turn scan rather than per-file scan** — agents typically write many files in a burst; per-file scans multiply cost (jscpd still scans the whole project) and produce fragmented reports. The scan runs while the turn is still in progress, and the decision is taken at the only boundary built for continuing the conversation.
2. **`agent_before_settle` with `continue: true` rather than notification alone** — the goal is to make the agent refactor immediately, while the work's context is still warm; the boundary guarantees exactly one continuation.
3. **Filter on written files + clone orientation** — only the duplication the agent has introduced or touched is reported, with the freshly written file oriented first for readability.
4. **Round cap + clone-set signature** — prevents infinite ping-pong between agent and verifier when a refactor does not reduce the duplication.
5. **Report under `os.tmpdir()`** — avoids the report being auto-included in the scan.
6. **jscpd via `npx` with no npm dependency of the extension** — keeps install zero-cost; a future release as a public npm package could replace the `npx` cold start with an explicit dependency.
7. **Double defense against non-first-party paths** — jscpd's glob `--ignore` does not reliably match dot-directories (`.git` is filtered poorly by brace patterns, verified on jscpd 5.3.3: sample git hooks leaked in and was reported as "refactor target"). Beyond the explicit patterns, a post-parse segment filter drops clones whose either side includes a junk segment (`.git`, `node_modules`, `dist`, ...).
8. **Header-only clone filter** — jscpd counts imports too: two Java test classes importing JUnit/Mockito/Spring-Test symbols easily exceed 50 tokens, but imports are not extractable logic. For every clone the `fragment` is stripped of blank lines, comments, and header lines (`package`/`import` for Java/Kotlin/Scala, `using`/`namespace ...;` for C#, `import`/`from ... import` for Python, single-line imports for TS/JS) and the tokens are re-counted approximately: if fewer than `minTokens` remain, the clone is dropped. Clones that include logic above the threshold survive. Applies to both the automatic mode and `/jscpd`.
9. **`:format` suffix normalization** — jscpd sometimes appends the format to the reported file name (`CHANGELOG.md:markdown`); parsing strips it when it coincides with the clone's format, otherwise the path-matching in automatic mode would fail silently.

## Development

```bash
npm install
npm test            # typecheck + vitest unit tests
npm run typecheck   # tsc --noEmit
npm run test:unit   # vitest run
```

There is no build step: pi loads the TypeScript extension directly.

Dependency-update PRs (npm packages + GitHub Actions) are produced by [Dependabot](https://docs.github.com/en/code-security/dependabot) on a weekly Monday schedule, configured in `.github/dependabot.yml`. Dependency bumps are grouped to keep PR noise low and labelled `dependencies` + `enhancement`.

## Release

1. Bump `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Commit on `main`.
3. Tag the release: `git tag v0.X.Y` and push the tag.
4. Create a GitHub release for the tag: `.github/workflows/publish.yml` runs typecheck + tests, verifies the tag matches `package.json`, and publishes to npm with `--access public`.

## License

MIT — see [LICENSE](./LICENSE).