import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { repoProviders } from '@horus/connectors';
import { searchAcrossRepos } from '@horus/engine';
import { failCommand } from '../lib/command-failure.js';

export async function runSearch(
  query: string,
  opts: { config?: string; limit?: number; json?: boolean },
): Promise<number> {
  try {
    return await search(query, opts);
  } catch (err) {
    // Shared machine-JSON failure contract: a no-config/host failure yields the clean
    // one-liner on stderr (no raw stack) and, under --json, one parseable object on stdout.
    return failCommand(err, opts.json);
  }
}

async function search(
  query: string,
  opts: { config?: string; limit?: number; json?: boolean },
): Promise<number> {
  const config = await loadConfig(opts.config);
  const providers = repoProviders(config);
  const results = await searchAcrossRepos(query, providers, opts.limit ?? 8);

  if (opts.json) {
    // Object contract (agent parity): every other command's --json is an object, so search
    // wraps its rows as `{ results: [...] }` instead of a bare top-level array.
    console.log(JSON.stringify({ results }, null, 2));
    return 0;
  }

  let totalMatches = 0;

  for (const result of results) {
    const statusDot = result.reachable ? pc.green('●') : pc.red('●');
    console.log('');
    console.log(`${statusDot}  ${pc.bold('## ' + result.repo)}  ${pc.dim(result.hostUrl)}`);

    if (!result.reachable) {
      console.log(pc.dim('  (unreachable)'));
    } else if (result.symbols.length === 0) {
      console.log(pc.dim('  (no matches)'));
    } else {
      for (const sym of result.symbols) {
        // Qualify with class + line so same-named hits are tellable apart (serde
        // dogfood: three visually-identical `deserialize` rows).
        const owner = sym.className ? pc.dim(`${sym.className}.`) : '';
        const line = sym.startLine ? pc.dim(`:${sym.startLine}`) : '';
        console.log(`  - ${owner}${pc.bold(sym.name)}  ${pc.dim(sym.filePath)}${line}`);
      }
      totalMatches += result.symbols.length;
    }
  }

  console.log('');
  const reachableCount = results.filter((r) => r.reachable).length;
  console.log(
    pc.dim(
      `${totalMatches} match(es) across ${reachableCount}/${results.length} reachable repo(s) for query: "${query}"`,
    ),
  );

  return 0;
}
