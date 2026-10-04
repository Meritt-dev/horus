import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import prettier from 'prettier';
import ts from 'typescript';

// Grandfather formatting only for byte-identical legacy files, never new changes.
const baseline = JSON.parse(
  readFileSync(new URL('./format-baseline.json', import.meta.url)),
);
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
let failures = 0;
let legacy = 0;
for (const file of files) {
  if (
    !/\.(?:[cm]?[jt]sx?|json|md)$/.test(file) ||
    /(?:^|\/)(?:brag-output|generated|vendor|fixtures)\//.test(file) ||
    file === 'docs/implementation/current-release.md'
  )
    continue;
  const source = readFileSync(file, 'utf8');
  if (
    !process.argv.includes('--format-only') &&
    /\.[cm]?tsx?$/.test(file) &&
    !file.includes('/source-py/')
  ) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const report = (node, rule) => {
      const { line, character } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      console.error(`${file}:${line + 1}:${character + 1} ${rule}`);
      failures++;
    };
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === 'eval')
          report(node, 'Do not evaluate dynamic code');
        if (
          ts.isIdentifier(node.expression) &&
          ['setTimeout', 'setInterval'].includes(node.expression.text) &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0])
        )
          report(node, 'Timers require functions, not strings');
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'forEach' &&
          node.arguments[0]?.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        )
          report(
            node,
            'async forEach discards promises; use an awaited loop or Promise.all',
          );
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Function'
      )
        report(node, 'Do not construct dynamic code');
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const options = await prettier.resolveConfig(file);
  const info = await prettier.getFileInfo(file);
  if (!info.inferredParser || info.ignored) continue;
  if (!(await prettier.check(source, { ...options, filepath: file }))) {
    const hash = createHash('sha256').update(source).digest('hex');
    if (baseline[file] === hash) legacy++;
    else {
      console.error(`${file}: formatting differs; run prettier --write on this file`);
      failures++;
    }
  }
}
console.log(
  `Lint: ${failures} failures; ${legacy} unchanged legacy formatting exceptions`,
);
process.exitCode = failures ? 1 : 0;
