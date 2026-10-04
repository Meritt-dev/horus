# Development workflow

Use AGENTS.md for execution restrictions and CODING_STANDARDS.md during review.
Automated suites run only in hosted CI. Local lint, formatting, typecheck and build
are allowed. Lint checks tracked TypeScript for unsafe dynamic code, string timers
and async forEach callbacks, and checks formatting with the installed Prettier.
The format baseline permits unchanged legacy files only; changed files must pass.
Do not regenerate that baseline to hide a new failure.

## CI monitoring

Run `python3 scripts/ci-watch.py OWNER/REPO RUN_ID --deadline 600` once. It prints
only changed job states, reads failed logs once, and exits 3 at the deadline if
still running; exit 2 means the observer is unavailable, not a failed run. Its optional `--state PATH` retains observed states across bounded
continuations. CI cancels superseded runs for the same branch, including duplicate push/PR triggers.
Stop checking a completed run. For unchanged external state, record
the blocker and resume only on a meaningful change or the stated time gate.
