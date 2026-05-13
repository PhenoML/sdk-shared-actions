import * as fs from "fs";
import * as path from "path";
import type { EndpointMapping, LanguageParser, TestExample } from "../types";
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
            pushEndpoint();
            currentMethod = null;
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
    }

    pushEndpoint();
    return endpoints;
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
