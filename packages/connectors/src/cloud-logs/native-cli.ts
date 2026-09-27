import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactErrorMessage } from '@horus/core';
const exec = promisify(execFile);
/** Reuse the local user's vendor login. Fixed argument arrays; never a shell or login prompt. */
export async function nativeOutput(
  executable: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await exec(executable, args, {
      timeout: 30_000,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      signal,
      env: {
        ...process.env,
        AWS_PAGER: '',
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
      },
    });
    return stdout.trim();
  } catch (error) {
    const e = error as Error & { stderr?: string };
    throw new Error(
      redactErrorMessage(`${executable}: ${e.stderr || e.message}`).slice(0, 1200),
    );
  }
}

export async function nativeJson(
  executable: string,
  args: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  return JSON.parse(await nativeOutput(executable, args, signal));
}
