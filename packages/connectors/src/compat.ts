import { PINNED_SOURCE_VERSION, SOURCE_PIN_ENFORCED } from '@horus/core';
import type { SourceHttpClient } from './source/client.js';

export interface SourceCompatibility {
  version: string | null;
  pinned: string;
  matches: boolean;
}

export async function checkSourceCompatibility(
  client: SourceHttpClient,
): Promise<SourceCompatibility> {
  const version = await client.version();
  return {
    version,
    pinned: PINNED_SOURCE_VERSION,
    // An unenforced pin (unbundled dev run, pin = 'dev') matches any backend.
    matches: !SOURCE_PIN_ENFORCED || version === PINNED_SOURCE_VERSION,
  };
}
