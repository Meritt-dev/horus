/**
 * Shared machine-JSON failure contract (dogfood 0.21.1 A1).
 *
 * Agents pipe a data command's stdout straight into `json.load`. Before this, a
 * pre-output failure (no config, host unreachable, bad args) left stdout EMPTY
 * under `--json` for every data command except `status` — so the parse hard-failed.
 * `failCommand` closes that gap: it emits ONE parseable object on stdout that
 * reuses `status`'s config-error field names (`ok`/`detail`, see status.ts), keeps
 * the human-readable detail on stderr exactly as before, and returns exit 1.
 *
 * Use it at a command's OUTER catch (and any other pre-output throw site) — the
 * `json` flag is whatever the command treats as "machine output requested"
 * (`--json` or `--format json`).
 */
import pc from 'picocolors';

/**
 * Report a command failure and return the process exit code (always 1).
 *
 * @param err  the caught error (message extracted defensively — errors may carry none)
 * @param json true when machine-readable output was requested (`--json`/`--format json`)
 */
export function failCommand(err: unknown, json: boolean | undefined): number {
  const detail = (err as Error)?.message || String(err);
  if (json) {
    // stdout stays VALID JSON even on a pre-output failure — one object, agent-parseable,
    // mirroring `horus status`'s { ok, detail } config-error shape.
    console.log(JSON.stringify({ ok: false, detail }, null, 2));
  }
  console.error(pc.red(detail));
  return 1;
}
