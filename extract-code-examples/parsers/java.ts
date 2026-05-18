import * as fs from "fs";
import * as path from "path";
import type {
    BodySchema,
    EndpointMapping,
    LanguageParser,
    ParamField,
    RenderSchema,
    SchemaFieldKind,
    TestExample,
} from "../types";
import type { JavaClassInfo } from "./java-request-class";
import {
    JAVA_PRIMITIVE_KIND,
    buildJavaBodySchema,
    findJavaClassFile,
    parseJavaClass,
} from "./java-request-class";
import { camelToSnake, findFiles, isBalancedParens, normalizePath } from "../utils";

// Per-@Test scan ceiling; also bounds nested SDK-call collection so an
// unterminated expression can't consume the rest of the file.
const MAX_TEST_BODY_LINES = 200;

export function createJavaParser(): LanguageParser {
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

            const resourcesDir = javaFindResourcesDir(rawClientFiles);
            const accessorMap = javaBuildAccessorMap(javaDir);
            // Cache parsed request classes across endpoints — the same class
            // (e.g. CohortRequest) is often referenced by multiple endpoints.
            const classCache = new Map<string, JavaClassInfo | null>();
            const endpoints: EndpointMapping[] = [];
            for (const file of rawClientFiles) {
                const fileEndpoints = javaExtractEndpoints(file, resourcesDir, accessorMap);
                for (const ep of fileEndpoints) {
                    ep.renderSchema = buildJavaRenderSchema(ep, file, classCache);
                }
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
export function javaCountBraceDelta(
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
    for (const f of rawClientFiles) {
        const idx = f.indexOf("/resources/");
        if (idx >= 0) return f.substring(0, idx + "/resources".length);
    }
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
export function javaBuildAccessorMap(javaDir: string): Map<string, string> {
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
            const fqn = imports.get(returnType) ?? `${pkg}.${returnType}`;
            const childFile = path.join(javaDir, fqn.replace(/\./g, "/") + ".java");
            if (childFile === clientFile) continue;
            if (!fs.existsSync(childFile)) continue;
            map.set(path.dirname(childFile), accessorName);
        }
    }

    return map;
}

export function javaExtractEndpoints(
    filePath: string,
    resourcesDir: string,
    accessorMap?: Map<string, string>,
): EndpointMapping[] {
    const source = fs.readFileSync(filePath, "utf-8");
    const lines = source.split("\n");
    const chain = javaDeriveMethodChain(filePath, resourcesDir, accessorMap);
    const endpoints: EndpointMapping[] = [];

    let currentMethod: string | null = null;
    let pathSegments: string[] = [];
    let httpMethod: string | null = null;
    let isStreaming = false;
    let collectingPath = false;
    let braceDepth = 0;
    let methodBraceDepth = 0;
    let methodBodyEntered = false;
    let bodyParamName: string | null = null;
    let requestClassName: string | null = null;
    let positionalParams: { name: string; type: string }[] = [];
    let bodyJsonKeys: string[] | null = null;
    let headerJsonKeys: string[] = [];
    // Accumulates the current Java statement across line breaks so calls
    // like `_requestBuilder.addHeader(\n  "X-...", request.getX());` are
    // matchable as a single string. Reset on `;`. Lightweight — we don't
    // track string/comment lexing here because the patterns we match
    // against (header names, getter calls) only appear in code.
    let stmtBuf = "";
    const seen = new Set<string>();
    const lexState = { inBlockComment: false, inTextBlock: false };

    // Closes over the loop locals so call sites just announce "save what
    // we've gathered so far". No-ops when the gathered state is incomplete.
    const pushEndpoint = () => {
        if (!currentMethod || !httpMethod || pathSegments.length === 0) return;
        const httpPath = normalizePath(pathSegments.join("/"));
        const key = `${httpMethod} ${httpPath}`;
        if (seen.has(key)) return;
        seen.add(key);
        const entry: EndpointMapping = {
            httpMethod,
            httpPath,
            methodChain: [...chain, currentMethod],
            methodName: currentMethod,
        };
        if (isStreaming) entry.isStreaming = true;
        if (requestClassName) entry.javaRequestClass = requestClassName;
        if (positionalParams.length > 0) entry.javaPositionalParams = positionalParams;
        if (bodyJsonKeys !== null) entry.javaBodyJsonKeys = bodyJsonKeys;
        if (headerJsonKeys.length > 0) entry.javaHeaderJsonKeys = headerJsonKeys;
        endpoints.push(entry);
    };

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
        // first inner `>` and miss the match entirely. Capture the inner type so
        // we can flag SSE endpoints (inner is `Iterable<...>`).
        const methodMatch = line.match(
            /public\s+PhenomlClientHttpResponse<(.+)>\s+(\w+)\s*\(/,
        );
        if (methodMatch) {
            pushEndpoint();
            currentMethod = methodMatch[2];
            // `Iterable<...>` is Fern's signal for an SSE-stream return; the
            // method body uses `Stream.fromSse(...)` instead of JSON parsing.
            isStreaming = /^Iterable\s*</.test(methodMatch[1].trim());
            pathSegments = [];
            httpMethod = null;
            collectingPath = false;
            // Enclosing-scope depth (class body). `delta > 0` only when the
            // body's `{` is on the signature line; otherwise we have to wait
            // for it on a later line — parameter-only lines of a multi-line
            // signature sit at this depth and must not be mistaken for an exit.
            methodBraceDepth = braceDepth - delta;
            methodBodyEntered = delta > 0;
            const classified = javaClassifySignatureParams(javaParseSignatureParams(lines, i));
            requestClassName = classified.requestClass;
            bodyParamName = classified.bodyParamName;
            positionalParams = classified.positional;
            bodyJsonKeys = null;
            headerJsonKeys = [];
            stmtBuf = "";
        }

        // Arm on the line where `{` lifts braceDepth above the enclosing scope.
        else if (currentMethod && !methodBodyEntered && braceDepth > methodBraceDepth) {
            methodBodyEntered = true;
        }
        // Exit once the body's `}` returns braceDepth to the enclosing scope.
        else if (currentMethod && methodBodyEntered && braceDepth <= methodBraceDepth) {
            pushEndpoint();
            currentMethod = null;
            requestClassName = null;
            bodyParamName = null;
            positionalParams = [];
            bodyJsonKeys = null;
            headerJsonKeys = [];
            stmtBuf = "";
        }

        if (!currentMethod) continue;

        // Streaming endpoints call `.newBuilder()` twice per method — once on
        // `HttpUrl` for the path, again on `OkHttpClient` for the call timeout.
        // Only the first is the URL builder.
        if (line.includes(".newBuilder()") && pathSegments.length === 0) {
            collectingPath = true;
        }

        if (collectingPath) {
            const segsMatch = line.match(/\.addPathSegments\s*\(\s*"([^"]+)"\s*\)/);
            if (segsMatch) pathSegments.push(segsMatch[1]);

            const segMatch = line.match(/\.addPathSegment\s*\(\s*(\w+)\s*\)/);
            if (segMatch) pathSegments.push(`{${camelToSnake(segMatch[1])}}`);

            if (line.includes(".build()")) collectingPath = false;
        }

        const httpMethodMatch = line.match(/\.method\s*\(\s*"(\w+)"\s*,/);
        if (httpMethodMatch) httpMethod = httpMethodMatch[1];

        // Header/body-field signals can span multiple lines in Fern's
        // output (`.addHeader(\n  "X-...", request.getX());`), so accumulate
        // per-statement (terminated by `;`) before pattern-matching.
        if (bodyParamName !== null) {
            stmtBuf += " " + line;
            if (line.endsWith(";") || line.endsWith("};")) {
                javaScanBodyStatement(stmtBuf, bodyParamName, (key) => {
                    if (bodyJsonKeys === null) bodyJsonKeys = [];
                    bodyJsonKeys.push(key);
                }, (headerKey) => {
                    headerJsonKeys.push(headerKey);
                });
                stmtBuf = "";
            }
        }
    }

    pushEndpoint();
    return endpoints;
}

// Type-name + identifier pair captured from a Java method signature.
interface SignatureParam {
    type: string;
    name: string;
}

// Collect the parameter list starting at the line containing the method's
// opening `(`. Returns each param as `{ type, name }`. Handles multi-line
// signatures by gathering text until the matching `)` is found, and ignores
// `RequestOptions` (always optional, never relevant to call rendering).
export function javaParseSignatureParams(lines: string[], startLine: number): SignatureParam[] {
    const openIdx = lines[startLine].indexOf("(");
    if (openIdx < 0) return [];
    // We're already past the opening paren, so paren depth starts at 1 and
    // we look for the line/column where it returns to 0. Generics and
    // annotations on individual params don't introduce parens, so a pure
    // paren counter is enough here (string literals don't appear in Fern's
    // generated signatures).
    let depth = 1;
    let paramList = "";
    for (let i = startLine; i < Math.min(startLine + 30, lines.length); i++) {
        const startCol = i === startLine ? openIdx + 1 : 0;
        const text = lines[i].slice(startCol);
        for (let c = 0; c < text.length; c++) {
            const ch = text[c];
            if (ch === "(") depth++;
            else if (ch === ")") {
                depth--;
                if (depth === 0) {
                    paramList += text.slice(0, c);
                    return javaParseParamList(paramList);
                }
            }
        }
        paramList += text + " ";
    }
    return [];
}

function javaParseParamList(paramList: string): SignatureParam[] {
    const trimmed = paramList.trim();
    if (!trimmed) return [];
    const params: SignatureParam[] = [];
    for (const raw of javaSplitTopLevelCommas(trimmed)) {
        const part = raw.trim();
        if (!part) continue;
        // Split on the LAST whitespace so multi-token types like
        // `Optional<String>` or `final @Nullable String` keep their type
        // text intact; the trailing token is the parameter identifier.
        const lastSpace = part.search(/\s\S+$/);
        if (lastSpace < 0) continue;
        const type = part.slice(0, lastSpace).trim();
        const name = part.slice(lastSpace + 1).trim();
        if (!type || !name) continue;
        params.push({ type, name });
    }
    return params;
}

// Split a Java parameter list on top-level commas, ignoring commas that
// appear inside generic angles, parens, or annotations.
function javaSplitTopLevelCommas(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "(" || c === "<" || c === "[") depth++;
        else if (c === ")" || c === ">" || c === "]") depth--;
        else if (c === "," && depth === 0) {
            out.push(s.slice(start, i));
            start = i + 1;
        }
    }
    out.push(s.slice(start));
    return out;
}

// Body resolution is best-effort: if the request class file can't be found
// or parsed, we still emit the call template + params (just without a body
// schema) so consumers can render the call shell.
export function buildJavaRenderSchema(
    endpoint: EndpointMapping,
    rawClientFile: string,
    classCache?: Map<string, JavaClassInfo | null>,
): RenderSchema {
    // Path-param placeholders use snake_case (matching URL templates) so a
    // consumer can key path params and body fields off the same wire names.
    const params: ParamField[] = (endpoint.javaPositionalParams ?? []).map((p) => ({
        name: camelToSnake(p.name),
        kind: javaInferParamKind(p.type),
    }));

    const accessors = endpoint.methodChain.slice(0, -1);
    const chainStr = ["client", ...accessors.map((a) => `${a}()`)].join(".")
        + "." + endpoint.methodName;
    const positionalStr = params.map((p) => `{{${p.name}}}`).join(", ");

    let callTemplate: string;
    let body: BodySchema | undefined;

    if (endpoint.javaRequestClass) {
        const bodyExpr = `${endpoint.javaRequestClass}.builder(){{__body__}}.build()`;
        callTemplate = `${chainStr}(${positionalStr ? `${positionalStr}, ${bodyExpr}` : bodyExpr})`;

        const classFile = findJavaClassFile(rawClientFile, endpoint.javaRequestClass);
        if (classFile) {
            const classInfo = parseJavaClassCached(classFile, classCache);
            if (classInfo) {
                body = buildJavaBodySchema(classInfo, {
                    headerJsonKeys: new Set(endpoint.javaHeaderJsonKeys ?? []),
                    bodyJsonKeys: endpoint.javaBodyJsonKeys,
                });
            }
        }
    } else {
        callTemplate = `${chainStr}(${positionalStr})`;
    }

    const schema: RenderSchema = { callTemplate, params };
    if (body) schema.body = body;
    return schema;
}

function parseJavaClassCached(
    filePath: string,
    cache?: Map<string, JavaClassInfo | null>,
): JavaClassInfo | null {
    if (!cache) return parseJavaClass(filePath);
    const cached = cache.get(filePath);
    if (cached !== undefined) return cached;
    const info = parseJavaClass(filePath);
    cache.set(filePath, info);
    return info;
}

// Path/query params come through the JAVA_PRIMITIVE_KIND table; unknown
// types fall back to "string" since Fern only ever emits scalar path args.
function javaInferParamKind(type: string): SchemaFieldKind {
    return JAVA_PRIMITIVE_KIND[type.trim()] ?? "string";
}

// Inspect a single (line-joined) Java statement for body-field and
// header-field signals. We look for two patterns Fern uses inside raw
// client methods:
//   `properties.put("jsonKey", request.getFoo())` — explicit body field
//   `.addHeader("X-...", request.getFoo()...)`    — body-class header
// The body-param identifier (`request` in Fern's output) is supplied by
// the caller so we only count calls that pull from THAT param, not e.g.
// `clientOptions.headers(...)`.
function javaScanBodyStatement(
    stmt: string,
    bodyParamName: string,
    onBodyKey: (key: string) => void,
    onHeaderKey: (key: string) => void,
): void {
    for (const m of stmt.matchAll(/\bproperties\.put\s*\(\s*"([^"]+)"\s*,/g)) {
        onBodyKey(m[1]);
    }
    for (const m of stmt.matchAll(/\.addHeader\s*\(\s*"([^"]+)"\s*,\s*([^)]*)/g)) {
        if (m[2].includes(`${bodyParamName}.`)) onHeaderKey(m[1]);
    }
}

// Classify Fern-generated signature params. The Fern Java codegen places
// path/query params first, the request body last (immediately before any
// trailing RequestOptions), and uses the type's "Request" suffix to mark
// body params unambiguously.
export function javaClassifySignatureParams(params: SignatureParam[]): {
    requestClass: string | null;
    bodyParamName: string | null;
    positional: { name: string; type: string }[];
} {
    // Drop trailing RequestOptions — never relevant to call rendering.
    const filtered = params.filter((p) => !/^RequestOptions\b/.test(p.type));
    if (filtered.length === 0) {
        return { requestClass: null, bodyParamName: null, positional: [] };
    }
    // The Fern convention names the body type with a "Request" suffix
    // (e.g. CohortRequest, AgentChatRequest). When the last param ends in
    // "Request", treat it as the body; otherwise this endpoint has no body
    // (e.g. GETs with only path params).
    const last = filtered[filtered.length - 1];
    const isBody = /Request$/.test(last.type) || last.type.includes(".Request");
    if (!isBody) {
        return {
            requestClass: null,
            bodyParamName: null,
            positional: filtered.map(({ name, type }) => ({ name, type })),
        };
    }
    return {
        requestClass: last.type,
        bodyParamName: last.name,
        positional: filtered.slice(0, -1).map(({ name, type }) => ({ name, type })),
    };
}

export function javaDeriveMethodChain(
    filePath: string,
    resourcesDir: string,
    accessorMap?: Map<string, string>,
): string[] {
    const relativePath = path.relative(resourcesDir, filePath).replace(/\\/g, "/");
    const parts = relativePath.split("/");
    parts.pop();
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

export function javaExtractTestExamples(filePath: string, rootDir?: string): TestExample[] {
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

        for (let j = i + 1; j < Math.min(i + MAX_TEST_BODY_LINES, lines.length); j++) {
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

            const methodAssert = line.match(/assertEquals\s*\(\s*"(\w+)"\s*,\s*request\.getMethod\(\)/);
            if (methodAssert) httpMethod = methodAssert[1];

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

            // SDK call: keep collecting while parens are unbalanced OR the
            // next line is a `.chained()` continuation. A `;` after balance
            // is a hard terminator (statement end).
            const sdkMatch = line.match(/(client\.\w[\w.()]*\(.*)/);
            if (sdkMatch && !sdkCallSource) {
                sdkCallSource = sdkMatch[1];
                for (let k = j + 1; k < Math.min(j + MAX_TEST_BODY_LINES, lines.length); k++) {
                    const balanced = isBalancedParens(sdkCallSource);
                    if (balanced && sdkCallSource.trimEnd().endsWith(";")) break;
                    const nextTrimmed = lines[k].trim();
                    if (!balanced || nextTrimmed.startsWith(".")) {
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
export function javaUnescape(s: string): string {
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

export function javaExtractSetBody(lines: string[], startLine: number, rootDir?: string): string | null {
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

export function javaExtractConcatenatedString(
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
