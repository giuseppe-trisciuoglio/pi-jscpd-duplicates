# pi-jscpd-duplicates

A pi extension that keeps AI-generated code clean of duplicate blocks by running an asynchronous jscpd scan after every file write and refactoring freshly introduced clones in the room when the agent settles.

## Language

**Clone**:
A pair of code fragments that jscpd has identified as duplicates (token-shingle overlap above the configured threshold). Each clone has two sides (`a` and `b`), each with a relative file path and a start/end line range, plus the duplication's `lines`, `tokens`, `format`, and the `fragment` that jscpd echoed back.
_Avoid_: duplicate, match, hit

**Written File**:
A file the agent wrote or edited this turn (`write` / `edit` tool results). The duplicate-code report only mentions clones that involve at least one written file; pre-existing duplication the agent never touched is left alone.
_Avoid_: edited file, modified file

**Debounced Scan**:
A jscpd scan scheduled by a trailing-edge timer (default 3 seconds after the last write/edit). Bursts of writes collapse into a single scan; any earlier in-flight scan is discarded because it is now stale.
_Avoid_: delayed scan, batched scan

**Background Scan**:
A jscpd scan launched as a separate process (`npx jscpd`) while the agent is still working. The scan normally completes before the turn ends, hiding it from the latency model.
_Avoid_: async scan, parallel scan

**End-of-Turn Report**:
The single consolidated duplicate-code report injected at `agent_before_settle`. Always includes a user notification (`ui.notify`); asks the agent to refactor with `continue: true` only when the turn outcome is `completed`, the clone-set signature differs from the previous round, and the round cap has not been reached.
_Avoid_: post-hoc report, summary

**Round Cap**:
The maximum number of refactor continuations per conversation chain (`MAX_REFACTOR_ROUNDS`, default 2). Reset on `agent_settled`. Prevents unbounded refactor loops.
_Avoid_: retry cap, iteration limit

**Clone-Set Signature**:
Stable fingerprint of a clone set (sorted `(file, startLine, endLine)` pairs joined into a string). If two consecutive rounds have the same signature, the refactor changed nothing, so no second round is offered.
_Avoid_: hash, fingerprint

**Header-Only Clone**:
A clone whose `fragment` is only package/import declarations, and/or comments. Two test files importing the same JUnit symbols reach 50 tokens easily, yet have no refactorable logic. Detected by `isHeaderOnly`: after stripping header and comment lines, the remaining meaningful tokens must stay above `minTokens` for the clone to be reported.
_Avoid_: import-only clone, false positive

**Junk Segment**:
A path segment (`.git`, `node_modules`, `dist`, ...) that marks a file as generated or vendored. Clones whose either side includes a junk segment are dropped even when the jscpd glob ignore missed them (the glob `--ignore` does not reliably match dot-directories).
_Avoid_: ignored path, third-party path

**Relevant Turn**: A turn that wrote or edited at least one supported file. Only relevant turns schedule a scan; non-relevant turns do not even start the debounce timer.