/**
 * Seed ranking (HOR-39). Search returns several candidate symbols for a vague hint;
 * we should not lock onto a tiny helper. Prefer architectural entry points
 * (resolver / controller / service / route / worker) over utils, scripts, and
 * legacy/migration code, and surface the ranked candidates with their role.
 */

import type { Symbol } from '@horus/core';

export interface RankedSeed {
  symbol: Symbol;
  score: number;
  role: string;
}

const PREFER =
  /resolver|controller|\bservice\b|route|router|handler|gateway|processor|worker|consumer|repository|usecase|use-case|endpoint/i;
const DEMOTE =
  /\butil|helper|\bscript|backfill|legacy|migration|seeder|fixture|\bmock\b|\btest\b|\bspec\b/i;
// dogfood GAP H: a PRESENTATION/format helper builds a display artifact — it neither performs
// the hinted action nor fails meaningfully, so it must not outrank the symbol that does the
// work (e.g. `buildDuplicateLeadMessage` must lose to `isDuplicateLeadSet`/`markDuplicateLead`
// for "duplicate leads not being detected").
const PRESENTATION_NAME =
  /^(build|format|render|compose|serialize)[A-Z].*(Message|Markup|Html|Text|Label|Summary|Notification|String)$/;
// A boolean PREDICATE (isX/hasX/canX/shouldX) is a DECISION point, not a thin passthrough —
// it must be EXEMPT from the short-symbol getter penalty (dogfood GAP H): `isDuplicateLeadSet`
// is only 2 lines but is exactly the detection logic the incident is about.
const PREDICATE_NAME = /^(is|has|can|should|was|were|are|does|did|needs|allows?|must)[A-Z]/;
// Type/DTO/interface declarations are not where a fault ORIGINATES — the fault lives
// in the method that throws, not the result/input type it returns or the interface it
// implements. Detect type-declaration naming conventions so a same-named method
// outranks a `…Result`/`…Input`/interface, and so the engine can re-search for the
// executable counterpart (HOR-337). (A full kind-based version via Symbol.kind from
// the graph label is the more complete follow-up; this name heuristic covers the
// common DTO/result-type collisions seen in practice.)
const TYPE_SUFFIX = /(Result|Input|Response|Payload|Args|Dto|Props|Edge|Connection)$/;
const INTERFACE_PREFIX = /^I(?=[A-Z][a-z])/;
const TYPE_LIKE_NAME = new RegExp(`(?:${TYPE_SUFFIX.source})|(?:${INTERFACE_PREFIX.source})`);

/** True when a symbol NAME follows type/DTO/interface declaration conventions. */
export function isTypeLikeName(name: string): boolean {
  return TYPE_LIKE_NAME.test(name);
}

// HOR-447: auto-generated codegen artifacts (GraphQL codegen, *.generated.*, __generated__/) hug
// hint tokens (a `Cart` type in `graphql/generated.tsx` scored 1.0) yet are never the incident
// surface — the fault is in the function that USES the generated type, not the generated type.
const CODEGEN_PATH_RE = /(^|\/)(?:__generated__|generated)\//i;
// A `generated.tsx` basename (preceded by `/` or start) OR a `*.generated.* / *.gen.*` suffix.
// (A bare `gen.ts` basename is deliberately NOT matched — too ambiguous.)
const CODEGEN_FILE_RE = /(?:(?:^|\/)generated|[._-](?:generated|gen))\.[jt]sx?$/i;
const GQL_GEN_FILE_RE = /\.(?:graphql|gql)\.[jt]sx?$/i;
/** True when a file path looks auto-generated (codegen) and so should not be the seed when real code exists. */
export function isCodegenPath(filePath: string): boolean {
  return CODEGEN_PATH_RE.test(filePath) || CODEGEN_FILE_RE.test(filePath) || GQL_GEN_FILE_RE.test(filePath);
}

// HOR-447: a symbol's graph KIND is the prefix of its id (`<kind>:<path>:<name>`, e.g.
// `type_alias:src/graphql/generated.tsx:Cart`). A type alias / interface / enum is a DECLARATION,
// not where a runtime fault originates — so an executable function/method must outrank a
// same-named type (the dogfood `Cart` type alias beat `cartReducer`). This is the authoritative
// kind-based companion to the name-heuristic {@link isTypeLikeName}.
const TYPE_DECL_KIND_RE = /^(?:type_alias|typealias|type|interface|enum)$/i;
export function isTypeDeclarationSymbol(s: Symbol): boolean {
  const kind = s.id.split(':', 1)[0] ?? '';
  return TYPE_DECL_KIND_RE.test(kind);
}

/**
 * Derive the executable counterpart name for a type-like name, or null.
 * e.g. "SyncBrandFulfillmentsResult" -> "SyncBrandFulfillments"; "IOrderService" -> "OrderService".
 */
export function executableBaseName(name: string): string | null {
  const stripped = name.replace(TYPE_SUFFIX, '').replace(INTERFACE_PREFIX, '');
  return stripped !== name && stripped.length >= 4 ? stripped : null;
}

/**
 * A `Class.method` or `path/to/file:symbol` disambiguator parsed out of an investigate hint
 * (HOR-337). When present, the seed whose symbol name === {@link symbol} AND whose container
 * (class / file path) matches {@link container} must be STRONGLY preferred over an unrelated
 * same-named symbol.
 */
export interface SeedQualifier {
  /** The bare symbol/method name (the part after the dot or colon). */
  symbol: string;
  /** The container — a class name (`Foo.bar`) or a file-path fragment (`path:symbol`). */
  container: string;
  /** True when the qualifier is the `path:symbol` form (container is a path, not a class). */
  isPath: boolean;
}

const PATH_QUALIFIER =
  // <left>:<ident> where <left> looks like a path (contains a slash or a file extension).
  /(?:^|[\s(])((?:[\w.@/-]*\/[\w.@/-]+)|(?:[\w@/-]+\.[A-Za-z]{1,5})):([A-Za-z_$][\w$]*)/;
const CLASS_QUALIFIER =
  // Capitalised container (class convention) dot method — avoids matching `file.ts` / `obj.x`.
  /\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_$][\w$]*)\b/;

/**
 * Parse a `Class.method` or `path/to/file:symbol` disambiguator out of an investigate hint.
 * Returns null when the hint contains no such qualified token (HOR-337).
 */
export function parseSeedQualifier(hint: string): SeedQualifier | null {
  const pathMatch = PATH_QUALIFIER.exec(hint);
  if (pathMatch && pathMatch[1] !== undefined && pathMatch[2] !== undefined) {
    const container = pathMatch[1].replace(/^\.?\/+/, '');
    if (container.length >= 2 && pathMatch[2].length >= 2) {
      return { symbol: pathMatch[2], container, isPath: true };
    }
  }
  const classMatch = CLASS_QUALIFIER.exec(hint);
  if (classMatch && classMatch[1] !== undefined && classMatch[2] !== undefined) {
    if (classMatch[1].length >= 2 && classMatch[2].length >= 2) {
      return { symbol: classMatch[2], container: classMatch[1], isPath: false };
    }
  }
  return null;
}

// HOR-385: named-symbol extraction tiers (most-specific first). Sources are kept as
// strings and re-instantiated with the `g` flag inside parseNamedSymbols so they
// carry no shared `lastIndex` state between calls.
const QUOTED_SYMBOL = /[`'"]([A-Za-z_$][\w$.]*)[`'"]/; // tier 2: `field`, 'Foo', "getX"
const PASCAL_SYMBOL = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/; // tier 3: SlideEditorProvider (≥2 humps; rejects "Does"/"Verify"/"Is")
const CAMEL_SYMBOL = /\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+)\b/; // tier 4: getUser, slideEditor
const SNAKE_SYMBOL = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/; // tier 5: get_user

/**
 * HOR-385: extract the symbol name(s) a structural hint refers to, so a source-impact
 * investigation can pin its seed onto the PROMPT-named symbol instead of the central
 * node. Tiered extraction (qualified → quoted → PascalCase → camelCase → snake_case);
 * a higher tier masks the text it claims so a lower (less-specific) tier cannot
 * re-extract it (e.g. the container of a `Class.method`, or a backticked PascalCase
 * name).
 *
 * The returned array is ordered by SOURCE-STRING POSITION, not extraction tier. This
 * is load-bearing for verify-isolation, where the array is read positionally
 * (`[0] = X` seed, `[1] = Y` isolation target): "verify SlideEditorProvider does not
 * affect `field`" must yield `[SlideEditorProvider, field]` even though the backticked
 * `field` is extracted in an earlier tier than the unquoted PascalCase `X`.
 */
export function parseNamedSymbols(hint: string): string[] {
  if (hint.length === 0) return [];
  const found: { name: string; index: number }[] = [];
  const seen = new Set<string>();
  // Mutable mask: a claimed span is blanked (same length, so indices stay aligned with
  // `hint`) before a lower tier runs.
  let masked = hint;
  const consume = (start: number, end: number): void => {
    masked = masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end);
  };
  const push = (name: string, index: number): void => {
    if (name.length < 2) return; // single chars are never a symbol pin
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name, index });
  };

  // Tier 1: qualified (Class.method / path:symbol) — pin the symbol part, claim the
  // whole qualified span so the container is not re-extracted as a bare PascalCase name.
  for (const src of [PATH_QUALIFIER, CLASS_QUALIFIER]) {
    const re = new RegExp(src.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const container = m[1];
      const symbol = m[2];
      if (
        container !== undefined &&
        symbol !== undefined &&
        container.length >= 2 &&
        symbol.length >= 2
      ) {
        push(symbol, m.index + m[0].lastIndexOf(symbol));
        consume(m.index, m.index + m[0].length);
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // Tiers 2-5: quoted, PascalCase, camelCase, snake_case.
  for (const src of [QUOTED_SYMBOL, PASCAL_SYMBOL, CAMEL_SYMBOL, SNAKE_SYMBOL]) {
    const re = new RegExp(src.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const name = m[1];
      if (name !== undefined) {
        push(name, m.index + m[0].indexOf(name));
        consume(m.index, m.index + m[0].length);
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  found.sort((a, b) => a.index - b.index);
  return found.map((f) => f.name);
}

/** Split a camel/Pascal/snake/kebab identifier into lowercase word tokens. */
function identTokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_./-]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Score contribution for a `Class.method` / `path:symbol` qualifier (HOR-337). The bare-name
 * match earns a moderate boost so a qualifier-named symbol beats unrelated seeds; a name + container
 * match earns a decisive boost so the EXACT method wins over a same-named symbol in another
 * class/file (e.g. `ProductService.syncProduct` resolves to that method, not an unrelated `syncProduct`).
 */
export function qualifierBoost(s: Symbol, q: SeedQualifier): number {
  const nameMatch = s.name.toLowerCase() === q.symbol.toLowerCase();
  if (!nameMatch) return 0;
  let boost = 6; // bare-name match
  const fp = s.filePath.toLowerCase();
  let containerMatch = false;
  if (q.isPath) {
    // Path form: the seed's file path must contain the given path fragment.
    containerMatch = fp.includes(q.container.toLowerCase());
  } else {
    // Class form: className equals Foo, OR the file path contains a kebab/snake/camel/no-sep
    // variant of Foo (e.g. `product.service.ts` for `ProductService`), OR the signature names Foo.
    const want = identTokens(q.container);
    const joined = want.join('');
    containerMatch =
      (s.className !== undefined && s.className.toLowerCase() === q.container.toLowerCase()) ||
      (want.length > 0 && want.every((t) => fp.includes(t))) ||
      (joined.length > 0 && fp.includes(joined)) ||
      (s.signature !== undefined && s.signature.toLowerCase().includes(q.container.toLowerCase()));
  }
  if (containerMatch) boost += 40; // decisive: this is the exact symbol the hint named
  return boost;
}

/** A coarse architectural role for display. */
export function seedRole(s: Symbol): string {
  const hay = `${s.name} ${s.filePath}`;
  if (/\.resolver\.|resolver/i.test(hay)) return 'resolver';
  if (/\.controller\.|controller/i.test(hay)) return 'controller';
  if (/\.service\.|service/i.test(hay)) return 'service';
  if (/processor|worker|consumer/i.test(hay)) return 'worker';
  if (/route|router|endpoint|handler|gateway/i.test(hay)) return 'route';
  if (/repository|\brepo\b/i.test(hay)) return 'repository';
  if (/(^|\/)scripts?\/|backfill|migration|seeder/i.test(hay)) return 'script';
  if (/util|helper/i.test(hay)) return 'util';
  return 'code';
}

/** Score a seed; higher = a more likely investigation entry point. */
export function scoreSeed(
  s: Symbol,
  index: number,
  hintTokens?: string[],
  changedFiles?: Set<string>,
  hintHasCode?: boolean,
  qualifier?: SeedQualifier | null,
  /**
   * HOR-385 (source-impact mode): the PROMPT-named symbol this investigation must pin onto.
   * When set, (i) a candidate whose name equals it earns a decisive boost so it beats a central
   * node, and (ii) the architectural-role PREFER promotion is suppressed so a central
   * controller/resolver/service cannot outrank the symbol the user actually named. Default
   * undefined ⇒ scoring is byte-identical to the incident path.
   */
  preferNamed?: string,
): number {
  const hay = `${s.name} ${s.filePath}`.toLowerCase();
  let score = 0;
  // Architectural-role signals (PREFER and the file-suffix below) are SUPPRESSED for a code hint:
  // when the hint names a specific code (HTTPFLT001, ERR243_04) the search surfaces its raise site
  // as an exact-content head match, and that raise site — wherever it lives — must win over a
  // same-score service-named symbol that merely co-occurs (dogfood gap 9). For a prose hint the
  // role stays a strong signal. HOR-385: also suppressed when a named symbol is being pinned, so
  // the central-node promotion can't steal the seed from the prompt-named symbol.
  const suppressRole = hintHasCode || preferNamed !== undefined;
  if (PREFER.test(hay)) score += suppressRole ? 0 : 3;
  if (DEMOTE.test(hay)) score -= 3;
  // GAP H: a presentation/format helper is not the failing actor.
  if (PRESENTATION_NAME.test(s.name)) score -= 3;
  // Demote type/DTO/interface-named symbols so an executable method wins a same-name
  // collision (HOR-337). Methods are verbs (syncProduct); types are nouns (…Result).
  if (isTypeLikeName(s.name)) score -= 4;
  // Demote thin getters/passthroughs (a few lines): the fault lives in the substantive
  // method they delegate to, not a 4-line field-resolver/getter that merely string-matches
  // the hint (HOR-337 follow-up — a getter must not outrank the real service).
  if (
    s.startLine !== undefined &&
    s.endLine !== undefined &&
    s.endLine - s.startLine <= 3 &&
    !PREDICATE_NAME.test(s.name) // GAP H: a thin boolean predicate is a decision, not a getter
  ) {
    score -= 3;
  }
  // Regression investigations (--since): a candidate that lives in a file changed in the
  // window is far more likely to be the culprit. Strong boost so the seed follows the diff
  // instead of locking onto an unrelated unchanged function (HOR-328 round-3).
  if (changedFiles !== undefined && changedFiles.has(s.filePath)) score += 5;
  // Strong file-suffix signals (suppressed for a code hint or a named-symbol pin — see above).
  if (/\.(resolver|controller|service)\.[jt]sx?$/i.test(s.filePath)) score += suppressRole ? 0 : 2;
  // Scripts/migrations are rarely the incident surface.
  if (/(^|\/)scripts?\//i.test(s.filePath)) score -= 2;
  // Tests assert behaviour and their names hug hints (`test_login_incorrect_password` for a
  // "login returns 401" hint), so they can outrank the real handler. The DEMOTE word-match
  // above misses common test PATHS — "tests/" (plural; no \b after) and "test_x.py"/"x_test.py"
  // (underscore is a word char, so \btest\b never fires) — so penalise them explicitly. The
  // implementation under test should win on a tie (HOR-361).
  if (
    /(^|\/)(tests?|__tests__|spec)\//i.test(s.filePath) ||
    /(\.|_)(test|spec)\.[jt]sx?$/i.test(s.filePath) ||
    /(^|\/)test_[^/]*\.py$/i.test(s.filePath) ||
    /_test\.py$/i.test(s.filePath)
  ) {
    score -= 4;
  }
  // Examples, tutorials, and docs snippets hug hints just like tests (a "detached instance error"
  // hint matched `docs_src/tutorial/...` over the real ORM, and an express hint matched
  // `examples/...` over `lib/`), and they're never the incident surface — demote them so the
  // library/app source wins on a tie (HOR-365).
  if (
    /(^|\/)(examples?|samples?|demos?|fixtures?|sandbox|playground|docs|docs_src|tutorials?)(\/|$)/i.test(
      s.filePath,
    )
  ) {
    score -= 4;
  }
  // Tie-break toward earlier search rank. For a code hint the search's exact-content head IS the
  // ordered list of raise sites, so trust that order strongly; for prose it's a mild nudge.
  score += Math.max(0, 5 - index) * (hintHasCode ? 0.8 : 0.1);
  // Source relevance: weighted HEAVILY only for a CODE-shaped hint (HTTPFLT001, E_SYNC_04…),
  // where a high exact-content / colocated score IS the raise site and must outweigh a
  // coincidental architectural match (gap 3). For a prose hint the search score (vector cosine /
  // FTS) is the SEMANTIC signal, so weight it ABOVE the raw lexical hint-token boost (+2/token,
  // capped +6) — a semantically-related candidate should out-rank a lexical-only false-friend
  // (HOR-430). Tuned CONSERVATIVELY (2.0, not the code-hint 8): the search score is still noisier
  // for prose — a schema named `Brand` scores 1.0 for "brand orders" while the real `checkBrand…`
  // function scores 0.03 — so the bump stays below the point where a single domain-word DTO match
  // would overtake a multi-token hint + role match (guarded by the Brand prose test below). The
  // decisive false-friend fix lives upstream in horus-source hybrid_search, where the exact-name
  // head is now path-deprioritized; this is the secondary corroboration knob.
  if (s.score !== undefined) score += s.score * (hintHasCode ? 8 : 2.0);
  // A File node is rarely the right seed — prefer the function/method that raises the signal.
  if (/\.[jt]sx?$/i.test(s.name)) score -= 5;
  // HOR-447: demote auto-generated codegen files and non-executable type declarations so an
  // executable implementation wins a same-name collision (a generated `Cart` type must lose to
  // `cartReducer`). These also trigger the decisive hard-demotion in rankSeeds when real code exists.
  if (isCodegenPath(s.filePath)) score -= 5;
  if (isTypeDeclarationSymbol(s)) score -= 6;
  // Domain-hint boost: strongly prefer symbols whose name/path contain hint tokens.
  // +2 per matching token, capped at +6 so a 3-token match decisively beats a
  // generic architectural-role match (max architectural score is +5).
  if (hintTokens !== undefined && hintTokens.length > 0) {
    let hintBoost = 0;
    for (const tok of hintTokens) {
      if (hay.includes(tok)) {
        hintBoost += 2;
        if (hintBoost >= 6) break;
      }
    }
    score += hintBoost;
  }
  // Class.method / path:symbol EXACT disambiguator (HOR-337): strongly prefer the seed whose
  // name === the qualifier symbol AND whose class/file matches the qualifier container.
  if (qualifier) score += qualifierBoost(s, qualifier);
  // HOR-385: decisive boost for the PROMPT-named symbol in source-impact mode — a `qualifierBoost`-
  // class +40 so the named symbol wins over a central node that merely scores high on role/fan-in.
  if (preferNamed !== undefined && s.name.toLowerCase() === preferNamed.toLowerCase()) score += 40;
  return score;
}

/** Rank seeds best-first. Stable for equal scores (preserves search order). */
/**
 * Test / example / docs / fixture paths that must never be the seed when real source exists.
 * Mirrors the path penalties in scoreSeed (HOR-361/365) and is the decision boundary for the
 * conditional hard-demotion in rankSeeds (HOR-376).
 */
export function isDeprioritizedSeedPath(filePath: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec)\//i.test(filePath) ||
    /(\.|_)(test|spec)\.[jt]sx?$/i.test(filePath) ||
    /(^|\/)test_[^/]*\.py$/i.test(filePath) ||
    /_test\.py$/i.test(filePath) ||
    /(^|\/)(examples?|samples?|demos?|fixtures?|sandbox|playground|docs|docs_src|tutorials?)(\/|$)/i.test(
      filePath,
    )
  );
}

/**
 * HOR-447: the FULL set of seeds hard-demoted below real executable code when any exists — the
 * test/example/docs paths above (HOR-376) PLUS auto-generated codegen files and non-executable type
 * declarations (type alias / interface / enum, by graph kind). A generated `Cart` type or a codegen
 * file is never the mechanism of a runtime symptom; the fault is in the function that uses it. The
 * `anchored` exemption (decisive qualifier / prompt-named / high-confidence code-hit) still applies,
 * so a deliberately-targeted type can surface.
 */
export function isDeprioritizedSeed(s: Symbol): boolean {
  return isDeprioritizedSeedPath(s.filePath) || isCodegenPath(s.filePath) || isTypeDeclarationSymbol(s);
}

/**
 * HOR-430: a deprioritized (test/example/demo/docs) candidate is normally hard-demoted below
 * every real candidate (HOR-376) so core code outranks demo/test code on a *shared keyword*.
 * But a STRONG, ANCHORED exact match in such a file must still be able to surface — the
 * down-weight is a ranking aid, not a filter. A candidate is "anchored" when the request
 * points at it unambiguously rather than merely sharing a token:
 *
 *   1. the user qualified the exact symbol AND its container/file (`Class.method`, `path:symbol`)
 *      via {@link qualifierBoost}'s decisive container match — e.g. `examples/app.ts:run`;
 *   2. the source-impact prompt named this exact symbol (`preferNamed`);
 *   3. a CODE-shaped hint resolved to a high-confidence exact-content / semantic hit here
 *      (search relevance ≈ 1.0) — i.e. the vector/lexical signal, not a coincidental keyword.
 *
 * Anchored candidates keep only the SOFT path penalty (HOR-361/365), so they still rank below an
 * EQUAL-strength real candidate but can overcome a weak one. This changes ranking ONLY — never
 * verdicts, confidence, or the honesty/"partly" logic.
 */
export function isAnchoredExactSeed(
  s: Symbol,
  qualifier?: SeedQualifier | null,
  hintHasCode?: boolean,
  preferNamed?: string,
): boolean {
  // (1) Decisive qualifier: name === qualifier symbol AND container/file matches. qualifierBoost
  // returns 6 for a bare-name-only match and ≥46 once the container matches, so ≥40 isolates the
  // exact, anchored match from an unrelated same-named symbol.
  if (qualifier && qualifierBoost(s, qualifier) >= 40) return true;
  // (2) The source-impact prompt named this exact symbol.
  if (preferNamed !== undefined && s.name.toLowerCase() === preferNamed.toLowerCase()) return true;
  // (3) A code hint resolved to a high-confidence exact-content/semantic hit here. For a prose
  // hint the search score is noisy (a schema named `Brand` scores 1.0 for "brand orders"), so this
  // anchor is restricted to code-shaped hints where ≈1.0 IS the raise site.
  if (hintHasCode === true && s.score !== undefined && s.score >= 0.9) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Exact-name collision ranking (dogfood P1). `explain <Name>` picked whichever
// same-named hit search scored first: hono `explain "Hono"` showed a 10-line
// preset subclass over the 545-line base class; clap `explain "Command"` showed a
// 1-line METHOD `command` over the central `Command` struct. Among candidates
// matching the query, prefer exact case, declaration kinds, real (non-test)
// paths, and larger bodies — the "N symbols named X" list then leads with the
// symbol the user almost certainly meant.
// ---------------------------------------------------------------------------

/** Graph kind (the id's `<kind>:` prefix) weight for an exact-name explain query. */
function explainKindWeight(s: Symbol): number {
  const kind = s.id.split(':', 1)[0] ?? '';
  switch (kind.toLowerCase()) {
    case 'class':
      return 4; // structs/classes — the usual referent of a bare Name query
    case 'interface':
    case 'enum':
      return 3;
    case 'function':
      return 2;
    case 'type_alias':
    case 'typealias':
      return 1;
    default:
      return 0; // methods & unknown kinds
  }
}

/**
 * Rank same-named candidates for an exact-name query (`explain Foo`). Returns the
 * candidates matching `query` case-insensitively, best first; empty when none match
 * exactly (callers keep their fuzzy-fallback behavior).
 */
export function rankExactCandidates(query: string, symbols: Symbol[]): Symbol[] {
  const q = query.toLowerCase();
  const exact = symbols.filter((s) => s.name.toLowerCase() === q);
  const scored = exact.map((symbol, i) => {
    let score = 0;
    if (symbol.name === query) score += 8; // exact case: Command ≠ command
    score += explainKindWeight(symbol);
    if (isDeprioritizedSeedPath(symbol.filePath) || isCodegenPath(symbol.filePath)) score -= 6;
    // Type-declaration shims: axios `explain "Axios"` picked index.d.ts:623 over the
    // lib/core/Axios.js implementation (both class-kind, LOC capped → tie broken by
    // search order). A .d.ts describes the API; the implementation IS the symbol.
    if (/\.d\.[cm]?ts$/i.test(symbol.filePath)) score -= 3;
    // Body size as a centrality proxy, log-dampened: a 545-line class beats a
    // 10-line re-export subclass, but 5000 lines doesn't beat everything forever.
    const loc = (symbol.endLine ?? 0) - (symbol.startLine ?? 0);
    if (loc > 0) score += Math.min(4, Math.log2(loc + 1));
    return { symbol, score, i };
  });
  return scored
    .sort((a, b) => (b.score === a.score ? a.i - b.i : b.score - a.score))
    .map((s) => s.symbol);
}

export function rankSeeds(
  seeds: Symbol[],
  hintTokens?: string[],
  changedFiles?: Set<string>,
  hintHasCode?: boolean,
  qualifier?: SeedQualifier | null,
  /** HOR-385: the prompt-named symbol to pin in source-impact mode (see scoreSeed). */
  preferNamed?: string,
): RankedSeed[] {
  const scored = seeds.map((symbol, i) => ({
    symbol,
    score: scoreSeed(symbol, i, hintTokens, changedFiles, hintHasCode, qualifier, preferNamed),
    role: seedRole(symbol),
    i,
    deprio: isDeprioritizedSeed(symbol),
    // HOR-430: a deprioritized candidate the request anchors on exactly is exempt from the
    // hard demotion below — it keeps only the soft path penalty so a strong/exact match in an
    // example/test file can still surface.
    anchored: isAnchoredExactSeed(symbol, qualifier, hintHasCode, preferNamed),
  }));
  // HOR-376: the −4 path penalties aren't decisive — a test fixture whose name hugs the hint
  // (e.g. pydantic's `tests/mypy/modules/plugin_fail.py` for "model validation recursion") can
  // still outscore the real implementation. When ANY real (non-test/example) candidate exists,
  // hard-demote every deprioritized candidate below all real ones. They remain available as a
  // last resort for genuinely test/example-only repos.
  // HOR-430: skip the hard demotion for an ANCHORED exact match (decisive qualifier / prompt-named
  // / high-confidence code-hint hit) so it can still surface — it keeps the soft −4 path penalty
  // from scoreSeed, so it ranks below an equal-strength real candidate but can beat a weak one.
  const hasReal = scored.some((s) => !s.deprio);
  if (hasReal) {
    for (const s of scored) if (s.deprio && !s.anchored) s.score -= 1000;
  }
  return scored
    .sort((a, b) => (b.score === a.score ? a.i - b.i : b.score - a.score))
    .map(({ symbol, score, role }) => ({ symbol, score, role }));
}
