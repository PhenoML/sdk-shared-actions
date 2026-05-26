import * as fs from "fs";
import * as path from "path";
import type { EndpointMapping, LanguageParser } from "../types";
import { camelToSnake, findFiles, normalizePath } from "../utils";

// Slim Java chain extractor. Depends on the following Fern codegen patterns:
//   1. Raw clients live at `src/main/java/.../resources/<group>/Raw<Name>Client.java`
//   2. Endpoint methods return `PhenoMLHttpResponse<T>` or `PhenomlClientHttpResponse<T>`
//   3. URL is built via `HttpUrl.parse(...).newBuilder().addPathSegments("literal")`
//      and `.addPathSegment(<identifier>)` for path params (separate calls)
//   4. HTTP method is set via `.method("VERB", body)` on the request builder
//   5. The last non-`RequestOptions` method parameter is the request body class
//   6. Top-level clients (`PhenomlClient.java`) declare `public XxxClient name()`
//      accessors that map resource directories to camelCase method names
//
// If codegen drifts and we extract zero endpoints from non-empty source,
// parseEndpoints throws with a clear error rather than silently emitting an
// empty manifest.
export function createJavaParser(): LanguageParser {
    return {
        language: "java",
        parseEndpoints(rootDir: string): EndpointMapping[] {
            const javaDir = path.join(rootDir, "src/main/java");
            if (!fs.existsSync(javaDir)) {
                console.error("  WARNING: No src/main/java/ directory found");
                return [];
            }
            // Walk the tree once, partition into:
            //   - raw clients (`RawXxxClient.java`) → endpoint extraction
            //   - top-level clients (no `Async`/`Raw` prefix) → accessor map
            // The async twin has the same endpoints with `CompletableFuture`
            // wrapping we don't need to chase.
            const allClientFiles = findFiles(javaDir, /\/\w+Client\.java$/);
            const rawClientFiles: string[] = [];
            const topLevelClientFiles: string[] = [];
            for (const f of allClientFiles) {
                const base = path.basename(f);
                if (base.startsWith("Async")) continue;
                if (base.startsWith("Raw")) rawClientFiles.push(f);
                else topLevelClientFiles.push(f);
            }
            if (rawClientFiles.length === 0) {
                console.error("  WARNING: No RawClient files found");
                return [];
            }
            const resourcesDir = javaFindResourcesDir(rawClientFiles);
            const accessorMap = javaBuildAccessorMap(javaDir, topLevelClientFiles);
            const endpoints: EndpointMapping[] = [];
            for (const file of rawClientFiles) {
                const fileEndpoints = javaExtractEndpoints(file, resourcesDir, accessorMap);
                endpoints.push(...fileEndpoints);
                console.error(`  ${path.relative(rootDir, file)}: ${fileEndpoints.length} endpoints`);
            }
            if (endpoints.length === 0) {
                throw new Error(
                    `Java parser found ${rawClientFiles.length} RawClient file(s) but extracted 0 endpoints. ` +
                    `Fern codegen format may have changed — verify the expected patterns ` +
                    `(see parsers/java.ts header for the full list).`,
                );
            }
            return endpoints;
        },
    };
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
// files. The lowercased directory name often isn't a valid Java accessor —
// e.g. the `fhirprovider` directory is reached via `fhirProvider()`. Empty
// when no client files exist (callers fall back to the directory basename).
export function javaBuildAccessorMap(
    javaDir: string,
    topLevelClientFiles?: string[],
): Map<string, string> {
    const map = new Map<string, string>();
    const clientFiles = topLevelClientFiles ?? findFiles(javaDir, /\/\w+Client\.java$/).filter((f) => {
        const base = path.basename(f);
        return !base.startsWith("Async") && !base.startsWith("Raw");
    });

    for (const clientFile of clientFiles) {
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
    const chain = javaDeriveMethodChain(filePath, resourcesDir, accessorMap);
    const endpoints: EndpointMapping[] = [];
    const seen = new Set<string>();

    // Each public endpoint method has multiple overloads (no-arg, with body,
    // with body + RequestOptions). Only the longest one carries the fetcher
    // code. We try every signature; ones whose body has no `.method(...)`
    // are silently dropped.
    let i = 0;
    while (i < source.length) {
        const sigMatch = source.slice(i).match(/public\s+(?:PhenoMLHttpResponse|PhenomlClientHttpResponse)\s*</);
        if (!sigMatch) break;
        const sigStart = i + sigMatch.index!;
        const ltIdx = sigStart + sigMatch[0].length - 1; // position of `<`
        const gtIdx = findMatchingAngle(source, ltIdx);
        if (gtIdx < 0) { i = ltIdx + 1; continue; }

        // After the closing `>`: `\s+(name)\s*(`. Capture method name + param list.
        const rest = source.slice(gtIdx + 1);
        const headerMatch = rest.match(/^\s+(\w+)\s*\(/);
        if (!headerMatch) { i = gtIdx + 1; continue; }

        const methodName = headerMatch[1];
        const parenIdx = gtIdx + 1 + headerMatch.index! + headerMatch[0].length - 1;
        const paramEnd = findMatchingClose(source, parenIdx, "(", ")");
        if (paramEnd < 0) { i = parenIdx + 1; continue; }
        const paramList = source.slice(parenIdx + 1, paramEnd);

        // Method body opens after the `)`; find the `{` then its matching `}`.
        const braceIdx = source.indexOf("{", paramEnd);
        if (braceIdx < 0) { i = paramEnd + 1; continue; }
        const bodyEnd = findMatchingClose(source, braceIdx, "{", "}");
        if (bodyEnd < 0) { i = braceIdx + 1; continue; }

        const body = source.slice(braceIdx + 1, bodyEnd);
        const info = javaExtractPathAndMethod(body);
        i = bodyEnd + 1;
        if (!info) continue;

        const httpPath = normalizePath(info.path);
        const key = `${info.method} ${httpPath}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const requestClassName = javaExtractRequestClassName(paramList);
        const entry: EndpointMapping = {
            httpMethod: info.method,
            httpPath,
            methodChain: [...chain, methodName],
            methodName,
        };
        if (requestClassName) entry.requestClassName = requestClassName;
        endpoints.push(entry);
    }
    return endpoints;
}

// Java scalars and common wrapper types that show up as path/query params.
// Picking one of these as the request class would emit `UUID.builder()...`
// or `Integer.builder()...` in the callTemplate, which doesn't compile.
const JAVA_SCALAR_PARAM_TYPES = new Set([
    "String", "int", "long", "double", "float", "boolean", "char", "byte", "short",
    "Integer", "Long", "Double", "Float", "Boolean", "Character", "Byte", "Short",
    "UUID", "BigDecimal", "BigInteger",
    "LocalDate", "LocalDateTime", "LocalTime",
    "OffsetDateTime", "OffsetTime", "Instant", "ZonedDateTime",
    "Duration", "Period", "URI", "URL",
]);

// Fern Java puts the request body LAST, immediately before any trailing
// `RequestOptions`. Look there; return undefined when the spot is a path
// param (scalar/wrapper type) or a passthrough body (`List<...>` etc. —
// those render through the spec's `passthroughBody` flag, not a builder).
// `Optional<XxxRequest>` unwraps to `XxxRequest`.
export function javaExtractRequestClassName(paramList: string): string | undefined {
    const params = splitJavaParams(paramList);
    while (params.length > 0 && paramType(params[params.length - 1]) === "RequestOptions") {
        params.pop();
    }
    if (params.length === 0) return undefined;
    const raw = paramType(params[params.length - 1]);
    if (!raw) return undefined;

    const candidate = unwrapOptional(raw) ?? raw;
    if (JAVA_SCALAR_PARAM_TYPES.has(candidate)) return undefined;
    if (isCollectionType(candidate)) return undefined;
    // Strip generic parameters if any survived — the builder is on the raw
    // class (`Foo.builder()`, not `Foo<Bar>.builder()`).
    return candidate.replace(/<.*$/, "").trim();
}

// Splits a Java parameter list on top-level commas, respecting `<...>`,
// `(...)`, and `[...]` nesting so types like `Map<String, Object> arg`
// aren't fractured at the comma inside the generic.
function splitJavaParams(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "<" || c === "(" || c === "[") depth++;
        else if (c === ">" || c === ")" || c === "]") depth--;
        else if (c === "," && depth === 0) {
            const piece = s.slice(start, i).trim();
            if (piece) out.push(piece);
            start = i + 1;
        }
    }
    const tail = s.slice(start).trim();
    if (tail) out.push(tail);
    return out;
}

// "`AgentCreateRequest request`" → "`AgentCreateRequest`".
function paramType(param: string): string | undefined {
    const m = param.match(/^(.+)\s+\w+\s*$/);
    return m ? m[1].trim() : undefined;
}

function unwrapOptional(t: string): string | undefined {
    const m = t.match(/^Optional\s*<\s*(.+)\s*>$/);
    return m ? m[1].trim() : undefined;
}

function isCollectionType(t: string): boolean {
    return /^(?:List|Set|Collection|Iterable|Map)\s*</.test(t);
}

function javaExtractPathAndMethod(body: string): { method: string; path: string } | null {
    const segments: string[] = [];
    let httpMethod: string | null = null;

    // Streaming endpoints call `.newBuilder()` twice (HttpUrl + OkHttpClient);
    // only the first builds the URL. Track that by stopping path collection
    // at the next `.build()` after we started.
    let collecting = false;
    for (const raw of body.split("\n")) {
        if (raw.includes(".newBuilder()") && segments.length === 0) collecting = true;
        if (collecting) {
            const segs = raw.match(/\.addPathSegments\s*\(\s*"([^"]+)"\s*\)/);
            if (segs) segments.push(segs[1]);
            const seg = raw.match(/\.addPathSegment\s*\(\s*(\w+)\s*\)/);
            if (seg) segments.push(`{${camelToSnake(seg[1])}}`);
            if (raw.includes(".build()") && segments.length > 0) collecting = false;
        }
        if (!httpMethod) {
            const mm = raw.match(/\.method\s*\(\s*"(\w+)"\s*,/);
            if (mm) httpMethod = mm[1];
        }
    }
    if (!httpMethod || segments.length === 0) return null;
    return { method: httpMethod, path: segments.join("/") };
}

// Returns the index of the `>` matching the `<` at `openIdx`. Naive: counts
// `<`/`>` depth across all of `s`, no string/comment awareness. Adequate for
// Fern-generated Java where angle brackets only appear in type expressions.
function findMatchingAngle(s: string, openIdx: number): number {
    return findMatchingClose(s, openIdx, "<", ">");
}

function findMatchingClose(s: string, openIdx: number, open: string, close: string): number {
    if (s[openIdx] !== open) return -1;
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        if (s[i] === open) depth++;
        else if (s[i] === close && --depth === 0) return i;
    }
    return -1;
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
    const chain: string[] = [];
    let dir = resourcesDir;
    for (const segment of parts) {
        dir = path.join(dir, segment);
        chain.push(accessorMap.get(dir) ?? segment);
    }
    return chain;
}
