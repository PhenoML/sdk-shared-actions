import * as fs from "fs";
import * as path from "path";
import type { EndpointMapping, LanguageParser } from "../types";
import { camelToSnake, findFiles, normalizePath } from "../utils";

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

// First non-RequestOptions, non-primitive parameter type is the body class.
// Returns undefined for path-only methods (just `String id, RequestOptions`).
function javaExtractRequestClassName(paramList: string): string | undefined {
    for (const raw of paramList.split(",")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^([\w.<>?\s]+?)\s+\w+\s*$/);
        if (!m) continue;
        const type = m[1].trim();
        if (type === "RequestOptions") continue;
        if (type === "String" || type === "int" || type === "long" || type === "double" ||
            type === "float" || type === "boolean" || type === "char" || type === "byte" ||
            type === "short" || type.startsWith("Optional<")) continue;
        return type.replace(/[<>?\s]+/g, "");
    }
    return undefined;
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
