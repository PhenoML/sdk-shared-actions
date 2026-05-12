/**
 * Multi-language code example extractor for Fern-generated SDKs.
 *
 * Extracts structured code examples by:
 * 1. Parsing client source files → endpoint-to-SDK-method mapping
 * 2. Parsing wire test files → example request/response data
 * 3. Combining into a code-examples.json manifest keyed by HTTP method + path
 *
 * Supports TypeScript, Python, and Java SDKs. Language is auto-detected
 * from .fern/metadata.json.
 *
 * Usage: npx tsx scripts/extract-code-examples.ts [--root /path/to/sdk]
 */

import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";

// ============================================================
// Types
// ============================================================

interface EndpointMapping {
    httpMethod: string;
    httpPath: string; // OpenAPI-style template, e.g., /agent/{id}
    methodChain: string[]; // e.g., ["agent", "create"]
    methodName: string; // e.g., "create"
    // Python-only: maps SDK kwarg name → JSON field name, derived from the
    // raw client's `json={"jsonKey": kwargName, ...}` dict. Used both to
    // exclude header/query/path kwargs from derived bodies and to emit the
    // correct (possibly aliased) wire field names. Undefined for TS/Java
    // (their parsers read body from a test literal) or when the raw client
    // doesn't use a `json={...}` dict literal (e.g., `json=body_var`).
    bodyParamMap?: Record<string, string>;
}

interface TestExample {
    httpMethod: string;
    httpPath: string; // Concrete path from mock, e.g., /agent/id
    methodName: string;
    describeBlock: string;
    requestBody: unknown | null;
    responseBody: unknown | null;
    sdkCallArgs: unknown[];
    sdkCallSource: string;
}

interface CodeExample {
    httpMethod: string;
    httpPath: string;
    sdkMethodChain: string[];
    sdkMethodName: string;
    request: {
        body: unknown | null;
        sdkCallArgs: unknown[];
    };
    response: {
        body: unknown | null;
    };
    sdkCallSource: string;
}

interface Manifest {
    metadata: {
        language: string;
        packageName: string;
        sdkVersion: string;
        specCommit: string;
        generatorName: string;
    };
    examples: Record<string, CodeExample>;
}

type Language = "typescript" | "python" | "java";

interface LanguageParser {
    language: Language;
    parseEndpoints(rootDir: string): EndpointMapping[];
    parseTestExamples(rootDir: string): TestExample[];
}

// ============================================================
// Shared utilities
// ============================================================

function findFiles(dir: string, pattern: RegExp): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    function walk(d: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (pattern.test(full)) results.push(full);
        }
    }
    walk(dir);
    return results.sort();
}

function normalizePath(p: string): string {
    p = p.replace(/\\/g, "/");
    if (!p.startsWith("/")) p = "/" + p;
    if (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
    return p;
}

function camelToSnake(str: string): string {
    return str
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase();
}

/**
 * Normalize path parameter names in a URL template to snake_case.
 * e.g., /construe/codes/{codeID} → /construe/codes/{code_id}
 * Ensures consistent keys across TS/Python/Java manifests.
 */
function normalizePathParams(httpPath: string): string {
    return httpPath.replace(/\{(\w+)\}/g, (_, name) => `{${camelToSnake(name)}}`);
}

// ============================================================
// Language detection
// ============================================================

interface FernMetadata {
    generatorName: string;
    sdkVersion: string;
    originGitCommit: string;
}

function detectLanguage(rootDir: string): { language: Language; metadata: FernMetadata } {
    const metadataPath = path.join(rootDir, ".fern", "metadata.json");
    if (!fs.existsSync(metadataPath)) {
        throw new Error(`Fern metadata not found at ${metadataPath}`);
    }
    const metadata: FernMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));

    if (metadata.generatorName.includes("typescript")) return { language: "typescript", metadata };
    if (metadata.generatorName.includes("python")) return { language: "python", metadata };
    if (metadata.generatorName.includes("java")) return { language: "java", metadata };

    throw new Error(`Unsupported generator: ${metadata.generatorName}`);
}

function getPackageName(rootDir: string, language: Language): string {
    switch (language) {
        case "typescript": {
            const pkgPath = path.join(rootDir, "package.json");
            if (fs.existsSync(pkgPath)) {
                return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).name || "unknown";
            }
            return "unknown";
        }
        case "python": {
            const pyprojectPath = path.join(rootDir, "pyproject.toml");
            if (fs.existsSync(pyprojectPath)) {
                const content = fs.readFileSync(pyprojectPath, "utf-8");
                const match = content.match(/name\s*=\s*"([^"]+)"/);
                if (match) return match[1];
            }
            return "unknown";
        }
        case "java": {
            const gradlePath = path.join(rootDir, "build.gradle");
            if (fs.existsSync(gradlePath)) {
                const content = fs.readFileSync(gradlePath, "utf-8");
                const groupMatch = content.match(/group\s*=\s*['"]([^'"]+)['"]/);
                const artifactMatch = content.match(/artifactId\s*=\s*['"]([^'"]+)['"]/);
                if (groupMatch && artifactMatch) return `${groupMatch[1]}:${artifactMatch[1]}`;
                if (groupMatch) return groupMatch[1];
            }
            return "unknown";
        }
    }
}

// ============================================================
// TypeScript parser
// ============================================================

function createTypeScriptParser(): LanguageParser {
    return {
        language: "typescript",

        parseEndpoints(rootDir: string): EndpointMapping[] {
            const clientFiles = findFiles(path.join(rootDir, "src/api/resources"), /\/client\/Client\.ts$/);
            const endpoints: EndpointMapping[] = [];
            for (const file of clientFiles) {
                const fileEndpoints = tsExtractEndpoints(file);
                endpoints.push(...fileEndpoints);
                console.error(`  ${path.relative(rootDir, file)}: ${fileEndpoints.length} endpoints`);
            }
            return endpoints;
        },

        parseTestExamples(rootDir: string): TestExample[] {
            const testDir = path.join(rootDir, "tests/wire");
            if (!fs.existsSync(testDir)) {
                console.error("  No wire test directory found");
                return [];
            }
            const testFiles = findFiles(testDir, /\.test\.ts$/);
            const examples: TestExample[] = [];
            for (const file of testFiles) {
                const fileExamples = tsExtractTestExamples(file);
                examples.push(...fileExamples);
                console.error(`  ${path.relative(rootDir, file)}: ${fileExamples.length} examples`);
            }
            return examples;
        },
    };
}

function tsExtractEndpoints(filePath: string): EndpointMapping[] {
    const source = fs.readFileSync(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    const methodChainPrefix = tsDeriveMethodChain(filePath);
    const endpoints: EndpointMapping[] = [];

    function visit(node: ts.Node) {
        // Find handleNonStatusCodeError(_response.error, _response.rawResponse, "POST", "/path")
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "handleNonStatusCodeError"
        ) {
            const args = node.arguments;
            if (args.length >= 4) {
                const httpMethodArg = args[2];
                const httpPathArg = args[3];
                if (ts.isStringLiteral(httpMethodArg) && ts.isStringLiteral(httpPathArg)) {
                    const methodName = tsFindEnclosingMethodName(node);
                    if (methodName) {
                        const publicName = methodName.replace(/^__/, "");
                        endpoints.push({
                            httpMethod: httpMethodArg.text,
                            httpPath: normalizePathParams(httpPathArg.text),
                            methodChain: [...methodChainPrefix, publicName],
                            methodName: publicName,
                        });
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return endpoints;
}

function tsDeriveMethodChain(filePath: string): string[] {
    const normalized = filePath.replace(/\\/g, "/");
    const match = normalized.match(/\/resources\/(.+?)\/client\/Client\.ts$/);
    if (!match) return [];
    return match[1].split("/resources/");
}

function tsFindEnclosingMethodName(node: ts.Node): string | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
        if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
            return current.name.text;
        }
        current = current.parent;
    }
    return null;
}

function tsExtractTestExamples(filePath: string): TestExample[] {
    const source = fs.readFileSync(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    const examples: TestExample[] = [];
    let describeBlock = "";

    function visit(node: ts.Node) {
        if (tsIsCallTo(node, "describe")) {
            const call = node as ts.CallExpression;
            if (call.arguments.length >= 1 && ts.isStringLiteral(call.arguments[0])) {
                describeBlock = call.arguments[0].text;
            }
        }

        // Only extract "(1)" tests — the success cases
        if (tsIsCallTo(node, "test")) {
            const call = node as ts.CallExpression;
            if (call.arguments.length >= 2 && ts.isStringLiteral(call.arguments[0])) {
                const testName = call.arguments[0].text;
                const nameMatch = testName.match(/^(.+?)\s*\(1\)$/);
                if (nameMatch) {
                    const methodName = nameMatch[1].trim();
                    const example = tsExtractFromTestBody(call.arguments[1], methodName, describeBlock, source);
                    if (example) examples.push(example);
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return examples;
}

function tsExtractFromTestBody(
    callbackNode: ts.Node,
    methodName: string,
    describeBlock: string,
    fullSource: string,
): TestExample | null {
    let body: ts.Node | undefined;
    if (ts.isArrowFunction(callbackNode) || ts.isFunctionExpression(callbackNode)) {
        body = callbackNode.body;
    }
    if (!body || !ts.isBlock(body)) return null;

    let requestBody: unknown | null = null;
    let responseBody: unknown | null = null;
    let httpMethod: string | null = null;
    let httpPath: string | null = null;
    let sdkCallArgs: unknown[] = [];
    let sdkCallSource = "";

    for (const stmt of body.statements) {
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) {
                    if (decl.name.text === "rawRequestBody" && decl.initializer) {
                        requestBody = tsEvalObjectLiteral(decl.initializer, fullSource);
                    }
                    if (decl.name.text === "rawResponseBody" && decl.initializer) {
                        responseBody = tsEvalObjectLiteral(decl.initializer, fullSource);
                    }
                }
                // SDK call in variable assignment
                if (decl.initializer) {
                    const callInfo = tsExtractSdkCall(decl.initializer, fullSource);
                    if (callInfo) {
                        sdkCallArgs = callInfo.args;
                        sdkCallSource = callInfo.source;
                    }
                }
            }
        }

        if (ts.isExpressionStatement(stmt)) {
            const mockInfo = tsExtractMockEndpoint(stmt.expression);
            if (mockInfo) {
                httpMethod = mockInfo.method;
                httpPath = mockInfo.path;
            }
            const callInfo = tsExtractSdkCall(stmt.expression, fullSource);
            if (callInfo) {
                sdkCallArgs = callInfo.args;
                sdkCallSource = callInfo.source;
            }
        }
    }

    if (!httpMethod || !httpPath) return null;
    return { httpMethod, httpPath, methodName, describeBlock, requestBody, responseBody, sdkCallArgs, sdkCallSource };
}

function tsExtractMockEndpoint(node: ts.Node): { method: string; path: string } | null {
    const httpMethods = ["get", "post", "put", "delete", "patch"];

    function findInChain(n: ts.Node): { method: string; path: string } | null {
        if (ts.isCallExpression(n)) {
            if (ts.isPropertyAccessExpression(n.expression)) {
                const name = n.expression.name.text;
                if (httpMethods.includes(name) && n.arguments.length >= 1) {
                    const arg = n.arguments[0];
                    if (ts.isStringLiteral(arg)) {
                        return { method: name.toUpperCase(), path: arg.text };
                    }
                }
            }
            if (ts.isPropertyAccessExpression(n.expression)) {
                const result = findInChain(n.expression.expression);
                if (result) return result;
            }
            const result = findInChain(n.expression);
            if (result) return result;
        }
        return null;
    }

    return findInChain(node);
}

function tsExtractSdkCall(node: ts.Node, fullSource: string): { args: unknown[]; source: string } | null {
    function findClientCall(n: ts.Node): ts.CallExpression | null {
        if (ts.isCallExpression(n)) {
            const chain = tsGetPropertyAccessChain(n.expression);
            if (chain.length > 0 && chain[0] === "client") return n;
        }
        if (ts.isAwaitExpression(n)) return findClientCall(n.expression);
        return null;
    }

    const callExpr = findClientCall(node);
    if (!callExpr) return null;
    const args = callExpr.arguments.map((arg) => tsEvalObjectLiteral(arg, fullSource));
    const source = fullSource.slice(callExpr.pos, callExpr.end).trim();
    return { args, source };
}

function tsGetPropertyAccessChain(node: ts.Node): string[] {
    if (ts.isIdentifier(node)) return [node.text];
    if (ts.isPropertyAccessExpression(node)) {
        return [...tsGetPropertyAccessChain(node.expression), node.name.text];
    }
    return [];
}

function tsIsCallTo(node: ts.Node, fnName: string): boolean {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === fnName;
}

function tsEvalObjectLiteral(node: ts.Node, fullSource: string): unknown {
    if (ts.isObjectLiteralExpression(node)) {
        const obj: Record<string, unknown> = {};
        for (const prop of node.properties) {
            if (ts.isPropertyAssignment(prop)) {
                const key = tsGetPropertyName(prop.name);
                if (key !== null) obj[key] = tsEvalObjectLiteral(prop.initializer, fullSource);
            }
            if (ts.isShorthandPropertyAssignment(prop)) obj[prop.name.text] = `<${prop.name.text}>`;
        }
        return obj;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map((el) => tsEvalObjectLiteral(el, fullSource));
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
    return `<expr:${fullSource.slice(node.pos, node.end).trim()}>`;
}

function tsGetPropertyName(node: ts.PropertyName): string | null {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return node.text;
    return null;
}

// ============================================================
// Python parser
// ============================================================

function createPythonParser(): LanguageParser {
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

function pyExtractEndpoints(filePath: string, pkgRoot: string): EndpointMapping[] {
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
        if (currentMethod && /self\._client_wrapper\.httpx_client\.(request|stream)\s*\(/.test(line)) {
            const httpPath = pyExtractRequestPath(lines, i);
            const httpMethod = pyExtractHttpMethod(lines, i);
            const bodyParamMap = pyExtractBodyParamMap(lines, i);

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
                        ...(bodyParamMap !== null ? { bodyParamMap } : {}),
                    });
                }
            }
            currentMethod = null;
        }
    }

    return endpoints;
}

function pyDeriveMethodChain(relativePath: string): string[] {
    // "cohort/raw_client.py" → ["cohort"]
    // "agent/resources/prompts/raw_client.py" → ["agent", "prompts"]
    // "tools/resources/mcp_server/raw_client.py" → ["tools", "mcp_server"]
    const parts = relativePath.replace(/\/raw_client\.py$/, "").split("/");
    return parts.filter((p) => p !== "resources");
}

function pyExtractRequestPath(lines: string[], startLine: number): string | null {
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

function pyExtractHttpMethod(lines: string[], startLine: number): string | null {
    for (let i = startLine; i < Math.min(startLine + 15, lines.length); i++) {
        const match = lines[i].match(/method\s*=\s*"(\w+)"/);
        if (match) return match[1];
    }
    return null;
}

// Scans the raw-client method body for `json={...}` and returns a map
// of SDK kwarg name → JSON field name for each top-level entry of the
// form `"<jsonField>": <kwarg>`. Fern sometimes aliases the wire field
// (e.g., `"someField": some_field`), so we have to preserve both sides
// — using just the kwarg name as the body key produces an HTTP body
// that doesn't match what the SDK actually sends.
//
// Returns null when no `json={` dict literal is found, so callers can
// fall back to their old heuristic for non-dict bodies (e.g., `json=body_var`).
function pyExtractBodyParamMap(lines: string[], startLine: number): Record<string, string> | null {
    const block = lines.slice(startLine, startLine + 100).join("\n");
    const match = block.match(/\bjson\s*=\s*\{/);
    if (!match) return null;
    const map: Record<string, string> = {};
    let depth = 0;
    let lastKey: string | null = null;
    let i = match.index! + match[0].length - 1; // at the `{`
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
            const kwarg = pyUnwrapBodyValue(block.slice(i + 1));
            if (kwarg !== null) map[kwarg] = lastKey;
            lastKey = null;
        } else if (depth === 1 && ch === ",") {
            lastKey = null;
        }
        i++;
    }
    return map;
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

function pyExtractTestExamples(
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

            // verify_request_count(test_id, "METHOD", "/path", ...)
            const verifyMatch = line.match(/verify_request_count\s*\([^,]+,\s*"(\w+)"\s*,\s*"([^"]+)"/);
            if (verifyMatch) {
                httpMethod = verifyMatch[1];
                httpPath = verifyMatch[2];
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
function pyParseKwargs(callSource: string): Array<{ name: string; value: unknown }> {
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

// ============================================================
// Java parser
// ============================================================

function createJavaParser(): LanguageParser {
    return {
        language: "java",

        parseEndpoints(rootDir: string): EndpointMapping[] {
            const javaDir = path.join(rootDir, "src/main/java");
            if (!fs.existsSync(javaDir)) {
                console.error("  WARNING: No src/main/java/ directory found");
                return [];
            }
            const rawClientFiles = findFiles(javaDir, /Raw\w+Client\.java$/);
            if (rawClientFiles.length === 0) {
                console.error("  WARNING: No RawClient files found");
                return [];
            }

            // Find the resources base directory
            const resourcesDir = javaFindResourcesDir(rawClientFiles);
            const accessorMap = javaBuildAccessorMap(javaDir);
            const endpoints: EndpointMapping[] = [];
            for (const file of rawClientFiles) {
                const fileEndpoints = javaExtractEndpoints(file, resourcesDir, accessorMap);
                endpoints.push(...fileEndpoints);
                console.error(`  ${path.relative(rootDir, file)}: ${fileEndpoints.length} endpoints`);
            }
            return endpoints;
        },

        parseTestExamples(rootDir: string): TestExample[] {
            // Wire tests are *WireTest.java files in src/test/
            const candidates = [path.join(rootDir, "src/test"), path.join(rootDir, "tests/wire")];
            for (const testDir of candidates) {
                if (!fs.existsSync(testDir)) continue;
                const wireTests = findFiles(testDir, /WireTest\.java$/);
                if (wireTests.length === 0) continue;

                const examples: TestExample[] = [];
                for (const file of wireTests) {
                    const fileExamples = javaExtractTestExamples(file, rootDir);
                    // Tag each example with its source file name for chain-based matching
                    const fileName = path.basename(file);
                    for (const ex of fileExamples) {
                        ex.describeBlock = fileName;
                    }
                    examples.push(...fileExamples);
                    console.error(`  ${path.relative(rootDir, file)}: ${fileExamples.length} examples`);
                }
                return examples;
            }

            console.error("  No wire test files found");
            return [];
        },
    };
}

// Returns the net `{` - `}` count for a single line, ignoring braces inside
// string literals, char literals, line comments, block comments, and text
// blocks. Block-comment and text-block state persists across lines via `state`.
function javaCountBraceDelta(
    line: string,
    state: { inBlockComment: boolean; inTextBlock: boolean },
): number {
    let delta = 0;
    let inString = false;
    let inChar = false;
    let c = 0;
    while (c < line.length) {
        const ch = line[c];
        const next = line[c + 1];

        if (state.inBlockComment) {
            if (ch === "*" && next === "/") { state.inBlockComment = false; c += 2; continue; }
            c++;
            continue;
        }
        if (state.inTextBlock) {
            if (ch === '"' && next === '"' && line[c + 2] === '"') { state.inTextBlock = false; c += 3; continue; }
            c++;
            continue;
        }
        if (inString) {
            if (ch === "\\") { c += 2; continue; }
            if (ch === '"') { inString = false; c++; continue; }
            c++;
            continue;
        }
        if (inChar) {
            if (ch === "\\") { c += 2; continue; }
            if (ch === "'") { inChar = false; c++; continue; }
            c++;
            continue;
        }

        if (ch === "/" && next === "/") break; // line comment: skip rest of line
        if (ch === "/" && next === "*") { state.inBlockComment = true; c += 2; continue; }
        if (ch === '"' && next === '"' && line[c + 2] === '"') { state.inTextBlock = true; c += 3; continue; }
        if (ch === '"') { inString = true; c++; continue; }
        if (ch === "'") { inChar = true; c++; continue; }
        if (ch === "{") delta++;
        else if (ch === "}") delta--;
        c++;
    }
    return delta;
}

function javaFindResourcesDir(rawClientFiles: string[]): string {
    // Find the common "resources" parent directory
    for (const f of rawClientFiles) {
        const idx = f.indexOf("/resources/");
        if (idx >= 0) return f.substring(0, idx + "/resources".length);
    }
    // Fallback: use the first file's parent
    return path.dirname(rawClientFiles[0]);
}

// Maps each resource sub-directory to the camelCase accessor that exposes it.
// Built from `public XxxClient accessorName()` patterns in the main *Client
// files (the lowercased directory name is not a valid Java accessor — e.g.
// the `fhirprovider` directory is reached via `fhirProvider()`). Each return
// type is resolved to a file path via the accessor file's `package` and
// `import` statements rather than a repo-wide basename lookup, so duplicate
// class names in different packages (e.g. a nested `tools/ToolsClient.java`
// alongside the top-level one) don't collide. Empty when no client files
// exist (tiny test fixtures); callers fall back to the directory basename.
function javaBuildAccessorMap(javaDir: string): Map<string, string> {
    const map = new Map<string, string>();
    const allClientFiles = findFiles(javaDir, /\/\w+Client\.java$/).filter((f) => {
        const base = path.basename(f);
        return !base.startsWith("Async") && !base.startsWith("Raw");
    });

    for (const clientFile of allClientFiles) {
        const source = fs.readFileSync(clientFile, "utf-8");
        const pkg = source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
        if (!pkg) continue;
        const imports = new Map<string, string>();
        const importPattern = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;
        let imp: RegExpExecArray | null;
        while ((imp = importPattern.exec(source)) !== null) {
            const fqn = imp[1];
            const shortName = fqn.split(".").pop();
            if (shortName && shortName !== "*") imports.set(shortName, fqn);
        }

        const accessorPattern = /public\s+(\w+Client)\s+(\w+)\s*\(\s*\)\s*\{/g;
        let match: RegExpExecArray | null;
        while ((match = accessorPattern.exec(source)) !== null) {
            const returnType = match[1];
            const accessorName = match[2];
            if (returnType.startsWith("Raw") || returnType.startsWith("Async")) continue;
            // Resolve via imports first; fall back to the accessor file's own package.
            const fqn = imports.get(returnType) ?? `${pkg}.${returnType}`;
            const childFile = path.join(javaDir, fqn.replace(/\./g, "/") + ".java");
            if (childFile === clientFile) continue;
            if (!fs.existsSync(childFile)) continue;
            map.set(path.dirname(childFile), accessorName);
        }
    }

    return map;
}

function javaExtractEndpoints(
    filePath: string,
    resourcesDir: string,
    accessorMap?: Map<string, string>,
): EndpointMapping[] {
    const source = fs.readFileSync(filePath, "utf-8");
    const lines = source.split("\n");
    const chain = javaDeriveMethodChain(filePath, resourcesDir, accessorMap);
    const endpoints: EndpointMapping[] = [];

    // Parse method by method: find public methods with HTTP implementations
    let currentMethod: string | null = null;
    let pathSegments: string[] = [];
    let httpMethod: string | null = null;
    let collectingPath = false;
    let braceDepth = 0;
    let methodBraceDepth = 0;
    const seen = new Set<string>();
    // Lexer state that persists across lines for constructs that can span lines.
    const lexState = { inBlockComment: false, inTextBlock: false };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Track brace depth for method boundaries, ignoring braces that appear
        // inside string literals, char literals, or comments (e.g. JSON
        // fragments like "{\"key\":" would otherwise corrupt the count).
        const delta = javaCountBraceDelta(line, lexState);
        braceDepth += delta;

        // Find method definition (only methods that return PhenomlClientHttpResponse).
        // Use greedy `.+` so nested generics like `Optional<Foo>` backtrack to land
        // on the outermost `>` before the method name; `[^>]+` would stop at the
        // first inner `>` and miss the match entirely.
        const methodMatch = line.match(
            /public\s+PhenomlClientHttpResponse<.+>\s+(\w+)\s*\(/,
        );
        if (methodMatch) {
            // Save previous method if it had HTTP details
            if (currentMethod && httpMethod && pathSegments.length > 0) {
                const httpPath = normalizePath(pathSegments.join("/"));
                const key = `${httpMethod} ${httpPath}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    endpoints.push({ httpMethod, httpPath, methodChain: [...chain, currentMethod], methodName: currentMethod });
                }
            }
            currentMethod = methodMatch[1];
            pathSegments = [];
            httpMethod = null;
            collectingPath = false;
            // methodBraceDepth is the brace depth INSIDE the method body. When
            // the signature ends on this line (`{` is here, delta > 0),
            // braceDepth already reflects that. When the signature spans
            // multiple lines and `{` comes later, anticipate the body open
            // with +1 so the closing `}` reliably triggers `braceDepth <
            // methodBraceDepth` instead of returning to exactly methodBraceDepth.
            methodBraceDepth = delta > 0 ? braceDepth : braceDepth + 1;
        }

        // Reset on method exit (brace depth returns to pre-method level).
        // `else if` rather than `if` so we don't fire the exit on the very
        // same line where methodMatch just (re)set methodBraceDepth — with
        // the multi-line-signature anticipation (+1), braceDepth would
        // immediately satisfy `< methodBraceDepth` and short-circuit the
        // newly-started method.
        else if (currentMethod && braceDepth < methodBraceDepth) {
            if (httpMethod && pathSegments.length > 0) {
                const httpPath = normalizePath(pathSegments.join("/"));
                const key = `${httpMethod} ${httpPath}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    endpoints.push({ httpMethod, httpPath, methodChain: [...chain, currentMethod], methodName: currentMethod });
                }
            }
            currentMethod = null;
        }

        if (!currentMethod) continue;

        // Detect URL builder start
        if (line.includes(".newBuilder()")) {
            collectingPath = true;
            pathSegments = [];
        }

        if (collectingPath) {
            // .addPathSegments("path/here")
            const segsMatch = line.match(/\.addPathSegments\s*\(\s*"([^"]+)"\s*\)/);
            if (segsMatch) pathSegments.push(segsMatch[1]);

            // .addPathSegment(paramName)
            const segMatch = line.match(/\.addPathSegment\s*\(\s*(\w+)\s*\)/);
            if (segMatch) pathSegments.push(`{${camelToSnake(segMatch[1])}}`);

            if (line.includes(".build()")) collectingPath = false;
        }

        // .method("POST", body)
        const httpMethodMatch = line.match(/\.method\s*\(\s*"(\w+)"\s*,/);
        if (httpMethodMatch) httpMethod = httpMethodMatch[1];
    }

    // Save final method
    if (currentMethod && httpMethod && pathSegments.length > 0) {
        const httpPath = normalizePath(pathSegments.join("/"));
        const key = `${httpMethod} ${httpPath}`;
        if (!seen.has(key)) {
            seen.add(key);
            endpoints.push({ httpMethod, httpPath, methodChain: [...chain, currentMethod], methodName: currentMethod });
        }
    }

    return endpoints;
}

function javaDeriveMethodChain(
    filePath: string,
    resourcesDir: string,
    accessorMap?: Map<string, string>,
): string[] {
    const relativePath = path.relative(resourcesDir, filePath).replace(/\\/g, "/");
    const parts = relativePath.split("/");
    parts.pop(); // Remove filename
    if (!accessorMap || accessorMap.size === 0) return parts;
    // Walk each directory level from resourcesDir down, remapping each
    // segment's lowercased basename to its camelCase accessor when known.
    const chain: string[] = [];
    let dir = resourcesDir;
    for (const segment of parts) {
        dir = path.join(dir, segment);
        chain.push(accessorMap.get(dir) ?? segment);
    }
    return chain;
}

function javaExtractTestExamples(filePath: string, rootDir?: string): TestExample[] {
    const source = fs.readFileSync(filePath, "utf-8");
    const lines = source.split("\n");
    const examples: TestExample[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== "@Test") continue;

        let methodName: string | null = null;
        for (let k = i + 1; k < Math.min(i + 3, lines.length); k++) {
            const methodMatch = lines[k].match(/public\s+void\s+test(\w+)\s*\(/);
            if (methodMatch) {
                methodName = methodMatch[1][0].toLowerCase() + methodMatch[1].slice(1);
                i = k;
                break;
            }
        }
        if (!methodName) continue;

        let httpMethod: string | null = null;
        let sdkCallSource = "";
        let requestBody: unknown = null;
        let responseBody: unknown = null;
        let mockResponseCount = 0;

        for (let j = i + 1; j < Math.min(i + 200, lines.length); j++) {
            const line = lines[j].trim();
            if (line === "@Test") break;

            // Count mock responses (first=OAuth, second=actual)
            if (line.includes("server.enqueue")) {
                mockResponseCount++;
                if (mockResponseCount === 2) {
                    const bodyStr = javaExtractSetBody(lines, j, rootDir);
                    if (bodyStr) {
                        try { responseBody = JSON.parse(bodyStr); } catch { responseBody = bodyStr; }
                    }
                }
            }

            // HTTP method: Assertions.assertEquals("POST", request.getMethod())
            const methodAssert = line.match(/assertEquals\s*\(\s*"(\w+)"\s*,\s*request\.getMethod\(\)/);
            if (methodAssert) httpMethod = methodAssert[1];

            // expectedRequestBody string
            if (line.includes("expectedRequestBody") && line.includes("=")) {
                const bodyStr = javaExtractConcatenatedString(lines, j, rootDir);
                if (bodyStr) {
                    try { requestBody = JSON.parse(bodyStr); } catch { /* skip */ }
                }
            }

            // expectedResponseBody string (more reliable than mock)
            if (line.includes("expectedResponseBody") && line.includes("=")) {
                const bodyStr = javaExtractConcatenatedString(lines, j, rootDir);
                if (bodyStr) {
                    try { responseBody = JSON.parse(bodyStr); } catch { /* keep mock version */ }
                }
            }

            // SDK call: ... = client.resource().method(...)
            // May span multiple lines with chained calls like client.tools()\n.mcpServer()\n.create(...)
            const sdkMatch = line.match(/(client\.\w[\w.()]*\(.*)/);
            if (sdkMatch && !sdkCallSource) {
                sdkCallSource = sdkMatch[1];
                for (let k = j + 1; k < Math.min(j + 30, lines.length); k++) {
                    const nextTrimmed = lines[k].trim();
                    // Continue if parens unbalanced or next line is a chained call
                    if (!isBalancedParens(sdkCallSource) || nextTrimmed.startsWith(".")) {
                        sdkCallSource += "\n" + lines[k];
                    } else {
                        break;
                    }
                }
                sdkCallSource = sdkCallSource.trim();
                if (sdkCallSource.endsWith(";")) sdkCallSource = sdkCallSource.slice(0, -1);
            }
        }

        if (httpMethod) {
            examples.push({
                httpMethod,
                httpPath: "",
                methodName,
                describeBlock: "",
                requestBody,
                responseBody,
                sdkCallArgs: [],
                sdkCallSource,
            });
        }
    }

    return examples;
}

// Single-pass unescape for Java string literals. Chained regex replaces can't
// handle this correctly because e.g. \\n (backslash+backslash+n, representing
// the two-char sequence \n at Java runtime) gets corrupted whichever order
// you replace \\ and \n in.
function javaUnescape(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "\\" && i + 1 < s.length) {
            const next = s[i + 1];
            switch (next) {
                case "n": out += "\n"; break;
                case "t": out += "\t"; break;
                case "r": out += "\r"; break;
                case '"': out += '"'; break;
                case "'": out += "'"; break;
                case "\\": out += "\\"; break;
                default: out += next; break;
            }
            i++;
        } else {
            out += s[i];
        }
    }
    return out;
}

// Resolve any `TestResources.loadResource("/path")` call found in `combined`
// to the contents of the fixture file under `src/test/resources/`. The leading
// slash on the resource path is the classpath convention. Returns null when
// no such call is present or the file can't be read.
function javaTryLoadResource(combined: string, rootDir: string | undefined): string | null {
    if (!rootDir) return null;
    const match = combined.match(/TestResources\.loadResource\s*\(\s*"([^"]+)"\s*\)/);
    if (!match) return null;
    const filePath = path.join(rootDir, "src/test/resources", match[1].replace(/^\/+/, ""));
    try {
        return fs.readFileSync(filePath, "utf-8");
    } catch {
        return null;
    }
}

function javaExtractSetBody(lines: string[], startLine: number, rootDir?: string): string | null {
    let combined = "";
    for (let i = startLine; i < Math.min(startLine + 15, lines.length); i++) {
        combined += lines[i];
        const loaded = javaTryLoadResource(combined, rootDir);
        if (loaded !== null) return loaded;
        const literalMatch = combined.match(/\.setBody\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/);
        if (literalMatch) return javaUnescape(literalMatch[1]);
    }
    return null;
}

function javaExtractConcatenatedString(
    lines: string[],
    startLine: number,
    rootDir?: string,
): string | null {
    let combined = "";
    for (let i = startLine; i < Math.min(startLine + 50, lines.length); i++) {
        combined += lines[i] + "\n";
        if (lines[i].trim().endsWith(";")) break;
    }
    const loaded = javaTryLoadResource(combined, rootDir);
    if (loaded !== null) return loaded;
    const parts: string[] = [];
    const stringLiteralPattern = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = stringLiteralPattern.exec(combined)) !== null) {
        parts.push(javaUnescape(m[1]));
    }
    if (parts.length === 0) return null;
    return parts.join("");
}

// ============================================================
// Shared helpers
// ============================================================

function isBalancedParens(str: string): boolean {
    let depth = 0;
    for (const ch of str) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (depth < 0) return false;
    }
    return depth === 0;
}

// Naive about strings/comments — same trade-off as isBalancedParens, which
// is fine for Fern-generated test bodies (no parens-in-strings in args).
// Drops trailing punctuation when the SDK call appears in a compound
// statement like `for _ in client.foo(...):` — the regex captures the `:`
// from the `for` header along with the call.
function truncateAfterMatchingParen(s: string): string {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")" && --depth === 0) return s.slice(0, i + 1);
    }
    return s;
}

// True if `concretePath` matches `templatePath` segment-by-segment, treating
// any "{name}" segment in the template as a wildcard. e.g. "/agent/{id}"
// matches "/agent/abc123".
function pathMatchesTemplate(templatePath: string, concretePath: string): boolean {
    const tmpl = templatePath.split("/");
    const concrete = concretePath.split("/");
    if (tmpl.length !== concrete.length) return false;
    for (let i = 0; i < tmpl.length; i++) {
        if (tmpl[i].startsWith("{") && tmpl[i].endsWith("}")) continue;
        if (tmpl[i] !== concrete[i]) return false;
    }
    return true;
}

// ============================================================
// Manifest builder
// ============================================================

function findTemplateMatch(
    httpMethod: string,
    concretePath: string,
    endpointMap: Map<string, EndpointMapping>,
): EndpointMapping | undefined {
    for (const [, endpoint] of endpointMap) {
        if (endpoint.httpMethod !== httpMethod) continue;
        if (pathMatchesTemplate(endpoint.httpPath, concretePath)) return endpoint;
    }
    return undefined;
}

// When `endpoint.bodyParamMap` is set (extracted from the raw client's
// `json={...}` dict), use it both to exclude header/query/path kwargs
// AND to translate the kwarg name back to the JSON field name (Fern
// sometimes aliases, e.g., `"someField": some_field`). Otherwise fall
// back to "everything except path params" with the kwarg name used as
// the body key — imperfect (header/query kwargs leak; aliased fields
// emit the wrong key) but the best we can do without raw-client info.
function deriveBodyFromKwargs(
    endpoint: EndpointMapping,
    sdkCallArgs: unknown[],
): unknown | null {
    if (!["POST", "PUT", "PATCH"].includes(endpoint.httpMethod)) return null;
    const resolveKey = bodyKeyResolver(endpoint);
    const body: Record<string, unknown> = {};
    let count = 0;
    for (const arg of sdkCallArgs) {
        if (!arg || typeof arg !== "object" || !("name" in arg) || !("value" in arg)) continue;
        const { name, value } = arg as { name: unknown; value: unknown };
        if (typeof name !== "string") continue;
        const key = resolveKey(name);
        if (key === null) continue;
        body[key] = value;
        count++;
    }
    return count > 0 ? body : null;
}

// Returns a function mapping an SDK kwarg name to its body field name,
// or null if the kwarg shouldn't be in the body at all.
function bodyKeyResolver(endpoint: EndpointMapping): (name: string) => string | null {
    if (endpoint.bodyParamMap !== undefined) {
        const map = endpoint.bodyParamMap;
        return (name) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null);
    }
    const pathParams = new Set<string>();
    for (const m of endpoint.httpPath.matchAll(/\{(\w+)\}/g)) pathParams.add(m[1]);
    return (name) => (pathParams.has(name) ? null : name);
}

function buildManifest(
    allEndpoints: EndpointMapping[],
    allExamples: TestExample[],
    language: Language,
    packageName: string,
    metadata: FernMetadata,
): Manifest {
    const endpointMap = new Map<string, EndpointMapping>();
    // Secondary index for chain-based matching (Java tests don't have httpPath).
    // Key: lowercased concat of chain-prefix segments + "." + methodName. Two
    // different chains can collapse to the same key (e.g. ["agent","prompts"]
    // and ["agentp","rompts"] both → "agentprompts"); when that happens we
    // drop the ambiguous entry so lookup misses loudly rather than silently
    // returning the wrong endpoint.
    const chainIndex = new Map<string, EndpointMapping>();
    const chainCollisions = new Set<string>();
    for (const ep of allEndpoints) {
        endpointMap.set(`${ep.httpMethod} ${ep.httpPath}`, ep);
        const prefix = ep.methodChain.slice(0, -1).join("").toLowerCase();
        const key = `${prefix}.${ep.methodName.toLowerCase()}`;
        const existing = chainIndex.get(key);
        if (existing && existing !== ep) {
            chainCollisions.add(key);
        }
        chainIndex.set(key, ep);
    }
    for (const key of chainCollisions) {
        console.error(`  WARNING: chain-index collision for "${key}"; dropping ambiguous entry`);
        chainIndex.delete(key);
    }

    const manifest: Manifest = {
        metadata: {
            language,
            packageName,
            sdkVersion: metadata.sdkVersion,
            specCommit: metadata.originGitCommit || "unknown",
            generatorName: metadata.generatorName,
        },
        examples: {},
    };

    let matched = 0;
    let unmatched = 0;

    for (const example of allExamples) {
        const exactKey = `${example.httpMethod} ${example.httpPath}`;
        let endpoint = endpointMap.get(exactKey) ?? findTemplateMatch(example.httpMethod, example.httpPath, endpointMap);

        // Fallback: match by method chain (for Java tests that don't have httpPath)
        if (!endpoint && !example.httpPath && example.describeBlock) {
            const filePrefix = example.describeBlock.replace(/WireTest\.java$/, "").toLowerCase();
            const chainKey = `${filePrefix}.${example.methodName.toLowerCase()}`;
            endpoint = chainIndex.get(chainKey);
        }

        if (endpoint) {
            const key = `${endpoint.httpMethod} ${endpoint.httpPath}`;
            const body = example.requestBody ?? deriveBodyFromKwargs(endpoint, example.sdkCallArgs);
            manifest.examples[key] = {
                httpMethod: endpoint.httpMethod,
                httpPath: endpoint.httpPath,
                sdkMethodChain: endpoint.methodChain,
                sdkMethodName: endpoint.methodName,
                request: { body, sdkCallArgs: example.sdkCallArgs },
                response: { body: example.responseBody },
                sdkCallSource: example.sdkCallSource,
            };
            matched++;
        } else {
            console.error(`  WARNING: No endpoint match for test: ${exactKey}`);
            unmatched++;
        }
    }

    const coveredKeys = new Set(Object.keys(manifest.examples));
    const uncovered = allEndpoints.filter((ep) => !coveredKeys.has(`${ep.httpMethod} ${ep.httpPath}`));
    if (uncovered.length > 0) {
        console.error(`\n  Endpoints without test coverage:`);
        for (const ep of uncovered) {
            console.error(`    ${ep.httpMethod} ${ep.httpPath} (${ep.methodChain.join(".")})`);
        }
    }

    console.error(`\n  Matched: ${matched}, Unmatched: ${unmatched}`);
    console.error(`  Coverage: ${matched}/${allEndpoints.length} endpoints have examples`);
    return manifest;
}

// ============================================================
// Main
// ============================================================

const SUPPORTED_LANGUAGES: readonly Language[] = ["typescript", "python", "java"];

function parseArgs(): { rootDir: string; language?: Language } {
    const args = process.argv.slice(2);
    let rootDir = process.cwd();
    let language: Language | undefined;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--root" && args[i + 1]) {
            rootDir = args[++i];
        } else if (args[i] === "--language" && args[i + 1]) {
            const value = args[++i];
            if (!SUPPORTED_LANGUAGES.includes(value as Language)) {
                throw new Error(
                    `Unsupported --language "${value}". Expected one of: ${SUPPORTED_LANGUAGES.join(", ")}`,
                );
            }
            language = value as Language;
        }
    }
    return { rootDir, language };
}

async function main() {
    const { rootDir, language: languageOverride } = parseArgs();

    let language: Language;
    let metadata: FernMetadata;

    const metadataPath = path.join(rootDir, ".fern", "metadata.json");
    if (fs.existsSync(metadataPath)) {
        const detected = detectLanguage(rootDir);
        language = languageOverride ?? detected.language;
        metadata = detected.metadata;
    } else if (languageOverride) {
        language = languageOverride;
        metadata = { generatorName: `fernapi/fern-${language}-sdk`, sdkVersion: "unknown", originGitCommit: "unknown" };
        console.error(`WARNING: No .fern/metadata.json found, using --language ${language}`);
    } else {
        throw new Error("No .fern/metadata.json found and no --language specified");
    }

    console.error(`Language: ${language} (${metadata.generatorName})\n`);

    let parser: LanguageParser;
    switch (language) {
        case "typescript": parser = createTypeScriptParser(); break;
        case "python": parser = createPythonParser(); break;
        case "java": parser = createJavaParser(); break;
        default: {
            const exhaustive: never = language;
            throw new Error(`Unsupported language: ${exhaustive}`);
        }
    }

    // Phase 1: Extract endpoint mappings from client source
    console.error("Phase 1: Parsing client source files...");
    const allEndpoints = parser.parseEndpoints(rootDir);
    console.error(`  Total: ${allEndpoints.length} endpoints\n`);

    // Phase 2: Extract examples from wire tests
    console.error("Phase 2: Parsing wire test files...");
    const allExamples = parser.parseTestExamples(rootDir);
    console.error(`  Total: ${allExamples.length} examples\n`);

    // Phase 3: Build manifest
    console.error("Phase 3: Building manifest...");
    const packageName = getPackageName(rootDir, language);
    const manifest = buildManifest(allEndpoints, allExamples, language, packageName, metadata);

    // Write manifest
    const outputPath = path.join(rootDir, "code-examples.json");
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n");
    console.error(`\nManifest written to ${outputPath}`);
}

// Run main() only when executed directly (not when imported, e.g. from tests).
if (import.meta.main) {
    main().catch((err) => {
        console.error("Error:", err);
        process.exit(1);
    });
}

// Exports for testing. Internal helpers — not a stable public API.
export {
    buildManifest,
    camelToSnake,
    createJavaParser,
    createPythonParser,
    createTypeScriptParser,
    deriveBodyFromKwargs,
    findTemplateMatch,
    isBalancedParens,
    javaBuildAccessorMap,
    javaCountBraceDelta,
    javaDeriveMethodChain,
    javaExtractConcatenatedString,
    javaExtractEndpoints,
    javaExtractSetBody,
    javaExtractTestExamples,
    javaUnescape,
    normalizePath,
    normalizePathParams,
    pyDeriveMethodChain,
    pyExtractBodyParamMap,
    pyExtractEndpoints,
    pyExtractHttpMethod,
    pyExtractRequestPath,
    pyExtractTestExamples,
    pyParseKwargs,
    truncateAfterMatchingParen,
    tsExtractEndpoints,
    tsExtractTestExamples,
};
