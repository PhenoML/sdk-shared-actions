import * as fs from "fs";
import * as path from "path";
import type { EndpointMapping, LanguageParser, TestExample } from "../types";
import {
    findFiles,
    isBalancedParens,
    normalizePath,
    normalizePathParams,
    pathMatchesTemplate,
    truncateAfterMatchingParen,
} from "../utils";

export function createPythonParser(): LanguageParser {
    return {
        language: "python",

        parseEndpoints(rootDir: string): EndpointMapping[] {
            // Find the package directory: src/{package_name}/
            const srcDir = path.join(rootDir, "src");
            if (!fs.existsSync(srcDir)) {
                console.error("  WARNING: No src/ directory found");
                return [];
            }
            const pkgDir = fs
                .readdirSync(srcDir, { withFileTypes: true })
                .find((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))?.name;
            if (!pkgDir) {
                console.error("  WARNING: Could not find Python package directory");
                return [];
            }

            const pkgRoot = path.join(srcDir, pkgDir);
            const clientFiles = findFiles(pkgRoot, /raw_client\.py$/);
            const endpoints: EndpointMapping[] = [];
            for (const file of clientFiles) {
                const fileEndpoints = pyExtractEndpoints(file, pkgRoot);
                endpoints.push(...fileEndpoints);
                console.error(`  ${path.relative(rootDir, file)}: ${fileEndpoints.length} endpoints`);
            }
            return endpoints;
        },

        parseTestExamples(rootDir: string): TestExample[] {
            // Load WireMock mappings for response bodies
            const wiremockPath = path.join(rootDir, "wiremock", "wiremock-mappings.json");
            const wiremockMap = new Map<string, { responseBody: unknown }>();
            if (fs.existsSync(wiremockPath)) {
                const mappings = JSON.parse(fs.readFileSync(wiremockPath, "utf-8")).mappings as Array<{
                    request: { urlPathTemplate: string; method: string };
                    response: { body?: string; status: number };
                }>;
                for (const m of mappings) {
                    const key = `${m.request.method} ${normalizePathParams(m.request.urlPathTemplate)}`;
                    let responseBody: unknown = null;
                    if (m.response.body) {
                        try { responseBody = JSON.parse(m.response.body); } catch { responseBody = m.response.body; }
                    }
                    wiremockMap.set(key, { responseBody });
                }
                console.error(`  Loaded ${wiremockMap.size} WireMock mappings`);
            }

            // Parse test files for SDK calls
            const testDir = path.join(rootDir, "tests/wire");
            if (!fs.existsSync(testDir)) {
                console.error("  No wire test directory found");
                return [];
            }
            const testFiles = findFiles(testDir, /test_.*\.py$/);
            if (testFiles.length === 0) {
                console.error("  No wire test files found");
                return [];
            }
            const examples: TestExample[] = [];
            for (const file of testFiles) {
                const fileExamples = pyExtractTestExamples(file, wiremockMap);
                examples.push(...fileExamples);
                console.error(`  ${path.relative(rootDir, file)}: ${fileExamples.length} examples`);
            }
            return examples;
        },
    };
}

export function pyExtractEndpoints(filePath: string, pkgRoot: string): EndpointMapping[] {
    const source = fs.readFileSync(filePath, "utf-8");
    const lines = source.split("\n");

    const relativePath = path.relative(pkgRoot, filePath).replace(/\\/g, "/");
    const chain = pyDeriveMethodChain(relativePath);
    if (chain.includes("core")) return [];

    const endpoints: EndpointMapping[] = [];
    let currentMethod: string | null = null;
    let inSyncClass = false;
    // Track methods we've already extracted to deduplicate (sync vs async)
    const seen = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track sync vs async class — only parse the sync class
        if (/^class\s+AsyncRaw\w+Client/.test(line)) {
            inSyncClass = false;
            continue;
        }
        if (/^class\s+Raw\w+Client/.test(line)) {
            inSyncClass = true;
            continue;
        }

        if (!inSyncClass) continue;

        // Find method definitions (skip __init__ and private methods)
        const methodMatch = line.match(/^\s{4}def\s+(\w+)\s*\(/);
        if (methodMatch && !methodMatch[1].startsWith("_")) {
            currentMethod = methodMatch[1];
        }

        // Find httpx_client.request() or httpx_client.stream() call
        const clientCallMatch = line.match(/self\._client_wrapper\.httpx_client\.(request|stream)\s*\(/);
        if (currentMethod && clientCallMatch) {
            const httpPath = pyExtractRequestPath(lines, i);
            const httpMethod = pyExtractHttpMethod(lines, i);
            const bodyShape = pyExtractBodyShape(lines, i);
            // `httpx_client.stream(...)` returns a streaming context manager;
            // the SDK parses SSE events from the body rather than JSON.
            const isStreaming = clientCallMatch[1] === "stream";

            if (httpPath && httpMethod) {
                // Also snake_case path-param names (Fern Python paths already
                // use snake_case in practice, but match the TS/Java parsers
                // so manifest keys stay consistent if that ever changes).
                const normalizedPath = normalizePathParams(normalizePath(httpPath));
                const key = `${httpMethod} ${normalizedPath}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    endpoints.push({
                        httpMethod,
                        httpPath: normalizedPath,
                        methodChain: [...chain, currentMethod],
                        methodName: currentMethod,
                        ...(bodyShape?.fields !== undefined ? { bodyParamMap: bodyShape.fields } : {}),
                        ...(bodyShape?.literals !== undefined ? { bodyLiterals: bodyShape.literals } : {}),
                        ...(bodyShape?.passthroughKwarg !== undefined
                            ? { bodyPassthroughKwarg: bodyShape.passthroughKwarg }
                            : {}),
                        ...(isStreaming ? { isStreaming: true } : {}),
                    });
                }
            }
            currentMethod = null;
        }
    }

    return endpoints;
}

export function pyDeriveMethodChain(relativePath: string): string[] {
    // "cohort/raw_client.py" → ["cohort"]
    // "agent/resources/prompts/raw_client.py" → ["agent", "prompts"]
    // "tools/resources/mcp_server/raw_client.py" → ["tools", "mcp_server"]
    const parts = relativePath.replace(/\/raw_client\.py$/, "").split("/");
    return parts.filter((p) => p !== "resources");
}

export function pyExtractRequestPath(lines: string[], startLine: number): string | null {
    // Scan forward from the request() call to find the path argument.
    // It's the first positional argument, on the same line or next few lines.
    for (let i = startLine; i < Math.min(startLine + 5, lines.length); i++) {
        const line = lines[i].trim();
        // f-string path: f"path/{encode_path_param(id)}". Strip any single
        // function wrapper around the param so the template uses just the
        // bare name (matches the OpenAPI shape and the TS/Java parsers).
        // Fern has used several wrapper names over time — jsonable_encoder,
        // url_encode, encode_path_param — so match generically.
        const fMatch = line.match(/f"([^"]+)"/);
        if (fMatch) {
            return fMatch[1].replace(/\{\w+\((\w+)\)\}/g, "{$1}");
        }
        // Simple string path: "path/here"  (but not method="POST" or headers=)
        const simpleMatch = line.match(/^"([^"]+)"\s*,/);
        if (simpleMatch && !line.includes("=")) return simpleMatch[1];
    }
    return null;
}

export function pyExtractHttpMethod(lines: string[], startLine: number): string | null {
    for (let i = startLine; i < Math.min(startLine + 15, lines.length); i++) {
        const match = lines[i].match(/method\s*=\s*"(\w+)"/);
        if (match) return match[1];
    }
    return null;
}

// Shape of the raw client's `json=` body as parsed from the request call.
// At most one of {fields/literals} and {passthroughKwarg} is populated; the
// fields/literals case is the `json={...}` dict shape, passthroughKwarg is
// the `json=<kwarg>` or `json=wrapper(object_=kwarg, ...)` shape.
export interface PyBodyShape {
    fields?: Record<string, string>;
    literals?: Record<string, unknown>;
    passthroughKwarg?: string;
}

// Inspects `json=...` on the request call and returns its shape. Returns
// null when no `json=` argument is present (e.g., GET endpoints) or when
// the value is too exotic to unwrap.
export function pyExtractBodyShape(lines: string[], startLine: number): PyBodyShape | null {
    const block = lines.slice(startLine, startLine + 100).join("\n");
    const match = block.match(/\bjson\s*=\s*/);
    if (!match) return null;
    const start = match.index! + match[0].length;
    if (block[start] === "{") {
        return pyScanJsonDict(block, start);
    }
    // Non-dict body: the entire HTTP payload is a single kwarg's value
    // (possibly wrapped by a serialization helper like
    // `convert_and_respect_annotation_metadata(object_=request, ...)`).
    // Used by PATCH endpoints whose body is a raw JSON Patch array.
    const kwarg = pyUnwrapBodyValue(block.slice(start));
    if (kwarg !== null) return { passthroughKwarg: kwarg };
    return null;
}

// Scans a `json={...}` dict literal starting at `openIdx` (the `{`),
// capturing both kwarg-sourced fields and inline literal values. Each
// top-level entry is `"<jsonField>": <value>`:
//   - if <value> unwraps to an identifier, it's an SDK kwarg → fields[kwarg] = jsonField
//   - if <value> is a string/number/bool/null literal → literals[jsonField] = value
//   - otherwise (nested dict/expression we can't resolve), the field is dropped
function pyScanJsonDict(block: string, openIdx: number): PyBodyShape {
    const fields: Record<string, string> = {};
    const literals: Record<string, unknown> = {};
    let depth = 0;
    let lastKey: string | null = null;
    let i = openIdx; // at the `{`
    while (i < block.length) {
        const ch = block[i];
        if (ch === '"' || ch === "'") {
            const quote = ch;
            const start = i + 1;
            i++;
            while (i < block.length) {
                if (block[i] === "\\") { i += 2; continue; }
                if (block[i] === quote) break;
                i++;
            }
            // Only top-level strings between `,` and `:` are field-name keys.
            if (depth === 1) lastKey = block.slice(start, i);
            i++;
            continue;
        }
        if (ch === "{" || ch === "[" || ch === "(") {
            depth++;
            lastKey = null; // entering a non-identifier value
            i++;
            continue;
        }
        if (ch === "}" || ch === "]" || ch === ")") {
            depth--;
            if (depth === 0) break;
            i++;
            continue;
        }
        if (depth === 1 && ch === ":" && lastKey !== null) {
            const after = block.slice(i + 1);
            const kwarg = pyUnwrapBodyValue(after);
            if (kwarg !== null) {
                fields[kwarg] = lastKey;
            } else {
                const literal = pyParseInlineLiteral(after);
                if (literal !== undefined) literals[lastKey] = literal;
            }
            lastKey = null;
        } else if (depth === 1 && ch === ",") {
            lastKey = null;
        }
        i++;
    }
    const out: PyBodyShape = { fields };
    if (Object.keys(literals).length > 0) out.literals = literals;
    return out;
}

// Back-compat shim for tests. Returns the kwarg → JSON field name map
// when the body is a `json={...}` dict, or null otherwise. Production
// code uses pyExtractBodyShape directly to also access literals and
// passthrough info.
export function pyExtractBodyParamMap(lines: string[], startLine: number): Record<string, string> | null {
    return pyExtractBodyShape(lines, startLine)?.fields ?? null;
}

// Parses a Python literal (string, int, float, True/False/None) from the
// start of `s`. Returns the JS value or undefined when `s` doesn't begin
// with a recognizable literal. Skips leading whitespace.
function pyParseInlineLiteral(s: string): unknown | undefined {
    let i = 0;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) return undefined;
    const ch = s[i];
    if (ch === '"' || ch === "'") {
        const quote = ch;
        let out = "";
        let j = i + 1;
        while (j < s.length) {
            if (s[j] === "\\" && j + 1 < s.length) {
                const next = s[j + 1];
                if (next === "n") out += "\n";
                else if (next === "t") out += "\t";
                else if (next === "r") out += "\r";
                else if (next === '"' || next === "'" || next === "\\") out += next;
                else out += next;
                j += 2;
                continue;
            }
            if (s[j] === quote) return out;
            out += s[j];
            j++;
        }
        return undefined; // unterminated
    }
    const numMatch = s.slice(i).match(/^(-?\d+(?:\.\d+)?)(?=\s*[,}\]])/);
    if (numMatch) return Number(numMatch[1]);
    const rest = s.slice(i);
    if (/^True(?=\s*[,}\]])/.test(rest)) return true;
    if (/^False(?=\s*[,}\]])/.test(rest)) return false;
    if (/^None(?=\s*[,}\]])/.test(rest)) return null;
    return undefined;
}

// Returns the SDK kwarg name that supplies the body field starting at
// position 0 of `s` (i.e., the slice just after `:` in `json={...}`).
// Handles three shapes Fern emits:
//   1. Bare identifier:           `conv_config`           → "conv_config"
//   2. Positional wrapper:        `jsonable_encoder(x)`   → "x"
//   3. `object_=`-keyed wrapper:  `helper(object_=x, ...)` → "x"
//      (e.g. `convert_and_respect_annotation_metadata`, used by current
//       Fern for serialization metadata.)
// Returns null when the value isn't an identifier (string/number literal)
// or the wrapper's args have no recoverable kwarg — the caller drops the
// entry rather than guessing wrong.
function pyUnwrapBodyValue(s: string): string | null {
    const ident = s.match(/^\s*([a-zA-Z_]\w*)/);
    if (!ident) return null;
    // Python literal keywords aren't kwargs — let the caller fall through
    // to literal parsing instead of producing a phantom "True" kwarg.
    if (ident[1] === "True" || ident[1] === "False" || ident[1] === "None") return null;
    const after = s.slice(ident[0].length);
    if (!after.startsWith("(")) return ident[1];
    const inner = pyExtractArgsPortion(after);
    if (inner === null) return null;
    const objArg = inner.match(/\bobject_\s*=\s*([a-zA-Z_]\w*)/);
    if (objArg) return objArg[1];
    const positional = inner.match(/^\s*([a-zA-Z_]\w*)(?=\s*(?:,|$))/);
    if (positional) return positional[1];
    return null;
}

export function pyExtractTestExamples(
    filePath: string,
    wiremockMap: Map<string, { responseBody: unknown }>,
): TestExample[] {
    const source = fs.readFileSync(filePath, "utf-8");
    const lines = source.split("\n");
    const examples: TestExample[] = [];

    // Pattern: def test_resource_method() -> None:
    //   ...
    //   client.resource.method(param=value, ...)
    //   verify_request_count(test_id, "METHOD", "/path", query_params, 1)
    for (let i = 0; i < lines.length; i++) {
        const testMatch = lines[i].match(/^def\s+(test_\w+)\s*\(\s*\)/);
        if (!testMatch) continue;

        let httpMethod: string | null = null;
        let httpPath: string | null = null;
        let sdkCallSource = "";

        // Scan to end of file; the loop terminates at the next top-level
        // `def test_*` below. An earlier fixed cap (60 lines) silently
        // truncated longer generated wire tests, dropping their entries.
        for (let j = i + 1; j < lines.length; j++) {
            const rawLine = lines[j];
            const line = rawLine.trim();
            // Next top-level test function ends this test. Anchor to column 0
            // (raw line) so indented nested `def test_*` helpers don't terminate.
            if (/^def\s+test_/.test(rawLine)) break;

            // verify_request_count(test_id, "METHOD", "/path", ...). Black
            // wraps long calls across multiple lines (open paren alone, args
            // and close paren on subsequent lines), so when we spot the call
            // collect text forward until parens balance before matching.
            if (rawLine.includes("verify_request_count")) {
                let block = rawLine;
                for (let k = j + 1; !isBalancedParens(block) && k < lines.length; k++) {
                    block += "\n" + lines[k];
                }
                const verifyMatch = block.match(
                    /verify_request_count\s*\([^,]+,\s*"(\w+)"\s*,\s*"([^"]+)"/,
                );
                if (verifyMatch) {
                    httpMethod = verifyMatch[1];
                    httpPath = verifyMatch[2];
                }
            }

            // SDK call: client.resource.method(...)
            const sdkMatch = line.match(/(client\.\w[\w.]*\(.*)/);
            if (sdkMatch && !sdkCallSource) {
                sdkCallSource = sdkMatch[1];
                if (!isBalancedParens(sdkCallSource)) {
                    for (let k = j + 1; k < Math.min(j + 30, lines.length); k++) {
                        sdkCallSource += "\n" + lines[k];
                        if (isBalancedParens(sdkCallSource)) break;
                    }
                }
                sdkCallSource = truncateAfterMatchingParen(sdkCallSource).trim();
            }
        }

        if (httpMethod && httpPath) {
            // Look up response body from WireMock mappings (template match)
            let responseBody: unknown = null;
            const exactKey = `${httpMethod} ${httpPath}`;
            const wmEntry = wiremockMap.get(exactKey);
            if (wmEntry) {
                responseBody = wmEntry.responseBody;
            } else {
                // Try template matching (concrete path like /agent/id → /agent/{id})
                for (const [wmKey, wm] of wiremockMap) {
                    if (!wmKey.startsWith(httpMethod + " ")) continue;
                    const wmPath = wmKey.slice(httpMethod.length + 1);
                    if (pathMatchesTemplate(wmPath, httpPath)) {
                        responseBody = wm.responseBody;
                        break;
                    }
                }
            }

            const methodName = testMatch[1].replace(/^test_\w+?_/, "").replace(/_$/, "");
            examples.push({
                httpMethod,
                httpPath,
                methodName,
                describeBlock: "",
                // requestBody is derived from kwargs in buildManifest where
                // the path template (and therefore path-param names) is known.
                requestBody: null,
                responseBody,
                sdkCallArgs: sdkCallSource ? pyParseKwargs(sdkCallSource) : [],
                sdkCallSource,
            });
        }
    }

    return examples;
}

// Hand-rolled because Node has no Python AST. Naive about exotic Python
// (single-quoted strings work, but f-strings, triple-quoted strings, and
// concatenated literals aren't handled) — fine for Fern-generated test
// bodies, which only ever use plain literal kwargs.
export function pyParseKwargs(callSource: string): Array<{ name: string; value: unknown }> {
    const portion = pyExtractArgsPortion(callSource);
    if (portion === null) return [];
    const out: Array<{ name: string; value: unknown }> = [];
    for (const piece of pySplitTopLevel(portion)) {
        const eq = pyFindTopLevelEquals(piece);
        if (eq < 0) continue; // positional arg — Fern tests don't use these
        const name = piece.slice(0, eq).trim();
        if (!/^\w+$/.test(name)) continue;
        out.push({ name, value: pyParseValue(piece.slice(eq + 1)) });
    }
    return out;
}

// Iterates `s` yielding each character outside of Python string literals,
// along with the current nesting depth across `()`, `[]`, and `{}`. Single-
// and double-quoted strings are skipped with backslash-escape awareness.
// `depth` reflects the value AFTER any bracket update for the yielded char,
// so the outermost `)` of a balanced call is yielded with depth 0.
function* pyWalkTopLevel(s: string): Generator<{ ch: string; i: number; depth: number }> {
    let depth = 0;
    let inString = false;
    let quote = "";
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (ch === "\\" && i + 1 < s.length) { i++; continue; }
            if (ch === quote) inString = false;
            continue;
        }
        if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        yield { ch, i, depth };
    }
}

function pyExtractArgsPortion(callSource: string): string | null {
    const open = callSource.indexOf("(");
    if (open < 0) return null;
    for (const { ch, i, depth } of pyWalkTopLevel(callSource.slice(open))) {
        if (ch === ")" && depth === 0) return callSource.slice(open + 1, open + i);
    }
    return null;
}

function pySplitTopLevel(s: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (const { ch, i, depth } of pyWalkTopLevel(s)) {
        if (ch === "," && depth === 0) {
            const part = s.slice(start, i).trim();
            if (part) out.push(part);
            start = i + 1;
        }
    }
    const tail = s.slice(start).trim();
    if (tail) out.push(tail);
    return out;
}

// Skips `==` so comparison expressions aren't mistaken for assignment.
function pyFindTopLevelEquals(s: string): number {
    for (const { ch, i, depth } of pyWalkTopLevel(s)) {
        if (ch === "=" && depth === 0 && s[i + 1] !== "=") return i;
    }
    return -1;
}

function pyParseValue(s: string): unknown {
    const trimmed = s.trim();
    if (!trimmed) return undefined;
    try {
        return JSON.parse(stripTrailingCommas(pyToJsonLiteral(trimmed)));
    } catch {
        return `<expr:${trimmed}>`;
    }
}

// Removes any `,` that precedes `]` or `}` (with optional whitespace between).
// Python allows — and Black formats multi-line lists/dicts with — trailing
// commas; JSON.parse rejects them, so without this strip every multi-line
// kwarg value would fall through to the `<expr:...>` escape hatch.
// String-literal aware so commas inside quoted values are preserved.
function stripTrailingCommas(s: string): string {
    let out = "";
    let inString = false;
    let quote = "";
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (ch === "\\" && i + 1 < s.length) { out += ch + s[i + 1]; i++; continue; }
            if (ch === quote) inString = false;
            out += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue; }
        if (ch === ",") {
            let j = i + 1;
            while (j < s.length && /\s/.test(s[j])) j++;
            if (j < s.length && (s[j] === "]" || s[j] === "}")) continue;
        }
        out += ch;
    }
    return out;
}

// Translates bare Python True/False/None to true/false/null so JSON.parse
// can read the result. Skips matches inside string literals and matches
// adjacent to word characters (e.g. `TrueOrFalse` is left alone).
function pyToJsonLiteral(s: string): string {
    let out = "";
    let inString = false;
    let quote = "";
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (inString) {
            if (ch === "\\" && i + 1 < s.length) { out += ch + s[i + 1]; i += 2; continue; }
            if (ch === quote) inString = false;
            out += ch;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; i++; continue; }
        const prev = i > 0 ? s[i - 1] : "";
        if (!/\w/.test(prev)) {
            if (s.startsWith("True", i) && !/\w/.test(s[i + 4] ?? "")) { out += "true"; i += 4; continue; }
            if (s.startsWith("False", i) && !/\w/.test(s[i + 5] ?? "")) { out += "false"; i += 5; continue; }
            if (s.startsWith("None", i) && !/\w/.test(s[i + 4] ?? "")) { out += "null"; i += 4; continue; }
        }
        out += ch;
        i++;
    }
    return out;
}
