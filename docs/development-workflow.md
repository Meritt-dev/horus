# Development workflow

Use AGENTS.md for execution restrictions and CODING_STANDARDS.md during review.
Automated suites run only in hosted CI. Local lint, formatting, typecheck and build
are allowed. Lint checks tracked TypeScript for unsafe dynamic code, string timers
and async forEach callbacks, and checks formatting with the installed Prettier.
The format baseline permits unchanged legacy files only; changed files must pass.
The generated receipt summary is validated by its generator instead of Prettier.
Do not regenerate that baseline to hide a new failure.

## CI monitoring

Run `python3 scripts/ci-watch.py OWNER/REPO RUN_ID --deadline 600` once. It prints
only changed job states, saves full failed logs once and prints focused failure excerpts, and exits 3 at the deadline if
still running; exit 2 means the observer is unavailable, not a failed run. Its optional `--state PATH` retains observed states across bounded
continuations. CI cancels superseded runs for the same branch, including duplicate push/PR triggers.
Stop checking a completed run. For unchanged external state, record
the blocker and resume only on a meaningful change or the stated time gate.

## Release evidence

`docs/implementation/current-release.json` is the current receipt. Update it only
from observed source/artifact/image/CI evidence. Run
`python3 scripts/release-receipt.py render docs/implementation/current-release.json`
to update its generated Markdown summary. The historical acceptance journal keeps
dated observations; it is not the current runtime state.

The hosted build records the CLI SHA-256 in its **Record publication-runner CLI
digest** step. Compare that observed Ubuntu/Node 22 digest with the installed
artifact in the receipt; a build passing alone does not establish equality.
The release workflow also rejects a rebuilt bundle that differs from the receipt.

Release workflows require the private recall bundle and the current paired Cloud
contract reported by the deployed public version endpoint. Ordinary PR CI can report an unavailable private holdout explicitly.
Neither mode bypasses open native-delivery or scenario-soak gates.
