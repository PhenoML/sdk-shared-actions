import * as fs from "fs";
import * as path from "path";
import type { EndpointMapping, LanguageParser } from "../types";
import { findFiles, findPythonPackageDir, normalizePath, normalizePathParams } from "../utils";

// Slim Python chain extractor. Depends on the following Fern codegen patterns:
//   1. Package lives at `src/<pkg>/`; raw clients at `<pkg>/.../raw_client.py`
//   2. Sync class is `class Raw<Name>Client:` (Async twin is skipped)
//   3. Endpoint methods are 4-space-indented `def <name>(self, ...):`
//   4. HTTP call is `self._client_wrapper.httpx_client.request(...)` or
//      `httpx_client.stream(...)` for SSE
//   5. Path is the first positional arg, either `"literal"` or `f"<template>"`;
//      path-param wrappers like `encode_path_param(<ident>)` are stripped
//   6. HTTP method is the `method="VERB"` kwarg
//   7. Structured request bodies pass `json={"<wire-key>": <python_ident>, ...}` —
//      the dict literal gives us the wire→identifier map verbatim
//   8. Passthrough request bodies pass `json=<ident>` or
//      `json=jsonable_encoder(<ident>)` — the bare identifier IS the SDK kwarg
//   9. Query params are passed as `params={"<wire-key>": <python_ident>, ...}`
//
// If codegen drifts and we extract zero endpoints from non-empty source,
// parseEndpoints throws with a clear error rather than silently emitting an
// empty manifest.
export function createPythonParser(): LanguageParser {
    return {
        language: "python",
        parseEndpoints(rootDir: string): EndpointMapping[] {
            const pkgDir = findPythonPackageDir(rootDir);
            if (!pkgDir) {
                console.error("  WARNING: Could not find Python package directory");
                return [];
            }
            const pkgRoot = path.join(rootDir, "src", pkgDir);
            const rawClientFiles = findFiles(pkgRoot, /raw_client\.py$/);
            const endpoints: EndpointMapping[] = [];
            for (const file of rawClientFiles) {
                const fileEndpoints = pyExtractEndpoints(file, pkgRoot);
                endpoints.push(...fileEndpoints);
                console.error(`  ${path.relative(rootDir, file)}: ${fileEndpoints.length} endpoints`);
            }
            if (rawClientFiles.length > 0 && endpoints.length === 0) {
                throw new Error(
                    `Python parser found ${rawClientFiles.length} raw_client.py file(s) but extracted 0 endpoints. ` +
                    `Fern codegen format may have changed — verify the expected patterns ` +
                    `(see parsers/python.ts header for the full list).`,
                );
            }
            return endpoints;
        },
    };
}

export function pyExtractEndpoints(filePath: string, pkgRoot: string): EndpointMapping[] {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");

    const relativePath = path.relative(pkgRoot, filePath).replace(/\\/g, "/");
    const chain = pyDeriveMethodChain(relativePath);
    if (chain.includes("core")) return [];

    const endpoints: EndpointMapping[] = [];
    let currentMethod: string | null = null;
    // Only parse the sync `Raw*Client` class; the async twin would emit dupes.
    let inSyncClass = false;
    const seen = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^class\s+AsyncRaw\w+Client/.test(line)) { inSyncClass = false; continue; }
        if (/^class\s+Raw\w+Client/.test(line)) { inSyncClass = true; continue; }
        if (!inSyncClass) continue;

        const methodMatch = line.match(/^\s{4}def\s+(\w+)\s*\(/);
        if (methodMatch && !methodMatch[1].startsWith("_")) {
            currentMethod = methodMatch[1];
        }

        if (currentMethod && /self\._client_wrapper\.httpx_client\.(request|stream)\s*\(/.test(line)) {
            const callText = pyCollectCallText(lines, i);
            const rawPath = pyExtractRequestPath(callText);
            const httpMethod = pyExtractHttpMethod(callText);
            if (rawPath && httpMethod) {
                const normalized = normalizePathParams(normalizePath(rawPath));
                const key = `${httpMethod} ${normalized}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const mapping: EndpointMapping = {
                        httpMethod,
                        httpPath: normalized,
                        methodChain: [...chain, currentMethod],
                        methodName: currentMethod,
                    };
                    const pathParamNames = pyExtractPathParamNames(rawPath);
                    if (pathParamNames.length > 0) mapping.pathParamNames = pathParamNames;
                    const body = pyExtractBodyKwargs(callText);
                    if (body?.kind === "dict") mapping.bodyKwargByJsonKey = body.kwargs;
                    else if (body?.kind === "passthrough") mapping.bodyKwargForPassthrough = body.ident;
                    const queryKwargs = pyExtractQueryKwargs(callText);
                    if (queryKwargs) {
                        mapping.bodyKwargByJsonKey = { ...(mapping.bodyKwargByJsonKey ?? {}), ...queryKwargs };
                    }
                    endpoints.push(mapping);
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
    const parts = relativePath.replace(/\/raw_client\.py$/, "").split("/");
    return parts.filter((p) => p !== "resources");
}

// Captures the full text of a `request(...)` / `stream(...)` call, starting
// at `startLine`'s opening paren and ending at the matching close. Multi-line
// calls (the common Fern shape) are joined into one string. Paren-depth
// tracking determines termination — large request models with many-line
// `json={...}` dicts must not be truncated mid-literal, otherwise the
// downstream brace-match in `pyExtractBodyKwargs` fails and the wire→ident
// map silently goes missing.
function pyCollectCallText(lines: string[], startLine: number): string {
    let buf = "";
    let depth = 0;
    let started = false;
    for (let i = startLine; i < lines.length; i++) {
        for (const c of lines[i]) {
            buf += c;
            if (c === "(") { depth++; started = true; }
            else if (c === ")") {
                depth--;
                if (started && depth === 0) return buf;
            }
        }
        buf += "\n";
    }
    return buf;
}

function pyExtractRequestPath(callText: string): string | null {
    // f-string template: `f"agent/{jsonable_encoder(id)}"`. Strip the
    // wrapper so the result is the bare `{id}` form the spec uses.
    const fMatch = callText.match(/f"([^"]+)"/);
    if (fMatch) return fMatch[1].replace(/\{\w+\((\w+)\)\}/g, "{$1}");
    // Plain string positional arg: the first string literal in the call.
    const simpleMatch = callText.match(/\(\s*"([^"]+)"\s*[,)]/);
    if (simpleMatch) return simpleMatch[1];
    return null;
}

function pyExtractHttpMethod(callText: string): string | null {
    const m = callText.match(/method\s*=\s*"(\w+)"/);
    return m ? m[1] : null;
}

// Extracts path-param Python identifiers from a (possibly-unnormalized)
// f-string path. The placeholders left after stripping `jsonable_encoder(...)`
// wrappers ARE the SDK's local identifiers, in URL order.
export function pyExtractPathParamNames(rawPath: string): string[] {
    const cleaned = rawPath.replace(/\{\w+\((\w+)\)\}/g, "{$1}");
    return [...cleaned.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

// Parses the `json=` argument. Two shapes:
//   - `json={"wire": ident, ...}` → structured body; returns wire→ident map
//   - `json=<ident>` or `json=jsonable_encoder(<ident>)` → passthrough; returns ident
// Returns null when there's no `json=` arg (e.g. GETs / DELETEs).
export function pyExtractBodyKwargs(callText: string):
    | { kind: "dict"; kwargs: Record<string, string> }
    | { kind: "passthrough"; ident: string }
    | null
{
    const jsonIdx = pyFindArgStart(callText, "json");
    if (jsonIdx < 0) return null;
    const value = callText.slice(jsonIdx).trimStart();
    if (value.startsWith("{")) {
        const close = pyFindMatchingClose(value, 0, "{", "}");
        if (close < 0) return null;
        return { kind: "dict", kwargs: pyParseDictEntries(value.slice(1, close)) };
    }
    // Bare or wrapped identifier — peel any outer `func(<inner>)` calls and
    // return the innermost identifier. Stops at the first comma/paren that
    // terminates the argument at the call's top level.
    const stop = pyFindArgEnd(value);
    const expr = value.slice(0, stop).trim();
    const ident = pyExtractInnermostIdentifier(expr);
    return ident ? { kind: "passthrough", ident } : null;
}

// Parses the `params={"wire": ident, ...}` arg into a wire→ident map. Returns
// null when there's no `params=` arg or it isn't a dict literal.
export function pyExtractQueryKwargs(callText: string): Record<string, string> | null {
    const idx = pyFindArgStart(callText, "params");
    if (idx < 0) return null;
    const value = callText.slice(idx).trimStart();
    if (!value.startsWith("{")) return null;
    const close = pyFindMatchingClose(value, 0, "{", "}");
    if (close < 0) return null;
    return pyParseDictEntries(value.slice(1, close));
}

// Finds the start of the value following `<argName>=` at the call's top level
// (depth-1 inside the outer `request(...)`). Returns the index AFTER the `=`,
// or -1 if not present. Skips matches that occur inside nested parens or
// brackets so a value like `json=jsonable_encoder(foo)` doesn't confuse a
// later `params=` lookup.
function pyFindArgStart(callText: string, argName: string): number {
    const pattern = new RegExp(`\\b${argName}\\s*=`, "g");
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(callText)) !== null) {
        if (pyDepthAt(callText, m.index) === 1) return m.index + m[0].length;
    }
    return -1;
}

// Tracks paren/brace/bracket nesting up to (but not including) `idx`.
function pyDepthAt(s: string, idx: number): number {
    let depth = 0;
    for (let i = 0; i < idx; i++) {
        const c = s[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
    }
    return depth;
}

function pyFindMatchingClose(s: string, openIdx: number, open: string, close: string): number {
    if (s[openIdx] !== open) return -1;
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        if (s[i] === open) depth++;
        else if (s[i] === close && --depth === 0) return i;
    }
    return -1;
}

// Index where the current argument's value ends — the first top-level comma
// or close-paren after `s[0]`. Used to bound bare-identifier scanning.
function pyFindArgEnd(s: string): number {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") {
            if (depth === 0) return i;
            depth--;
        } else if (c === "," && depth === 0) return i;
    }
    return s.length;
}

// "jsonable_encoder(my_arg)" → "my_arg"; "foo(bar(my_arg))" → "my_arg";
// bare "request" → "request". Returns null for anything else (e.g. a dict
// comprehension, a literal, an attribute chain).
function pyExtractInnermostIdentifier(expr: string): string | null {
    let cur = expr.trim();
    while (true) {
        const callMatch = cur.match(/^\w+\s*\(\s*([\s\S]+?)\s*\)\s*$/);
        if (!callMatch) break;
        cur = callMatch[1].trim();
    }
    return /^\w+$/.test(cur) ? cur : null;
}

// Parses `"wire1": ident1, "wire2": jsonable_encoder(ident2), ...` into a
// wire→ident map. Tolerates jsonable_encoder() wrappers around the value;
// anything more exotic (dict comprehensions, conditionals) is silently
// skipped — the renderer will fall back to the wire key as the kwarg name.
function pyParseDictEntries(body: string): Record<string, string> {
    const out: Record<string, string> = {};
    const entryPattern = /"([^"]+)"\s*:\s*([^,]+?)(?=,|$)/g;
    let m: RegExpExecArray | null;
    while ((m = entryPattern.exec(body)) !== null) {
        const ident = pyExtractInnermostIdentifier(m[2]);
        if (ident) out[m[1]] = ident;
    }
    return out;
}
