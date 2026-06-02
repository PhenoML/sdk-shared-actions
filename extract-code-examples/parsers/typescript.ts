import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type { EndpointMapping, LanguageParser } from "../types";
import { findFiles, normalizePathParams } from "../utils";

// Slim TypeScript chain extractor. Depends on the following Fern codegen patterns:
//   1. Resource clients live at `src/api/resources/.../client/Client.ts`
//   2. Endpoint impls are `private async __<name>(...)` (the public method
//      delegates to the private impl)
//   3. The impl body contains a fetcher object literal with `url:` and
//      `method:` properties
//   4. URL is one of: `core.url.join(<base>, <pathArg>)`, a string literal,
//      a template literal with substitutions, or a `${baseUrl}`-prefix template
//   5. Path-param substitutions are bare identifiers or
//      `core.url.encodePathParam(<ident>)` calls
//
// If codegen drifts and we extract zero endpoints from non-empty source,
// parseEndpoints throws with a clear error rather than silently emitting an
// empty manifest.
export function createTypeScriptParser(): LanguageParser {
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
            if (clientFiles.length > 0 && endpoints.length === 0) {
                throw new Error(
                    `TypeScript parser found ${clientFiles.length} Client.ts file(s) but extracted 0 endpoints. ` +
                    `Fern codegen format may have changed — verify the expected patterns ` +
                    `(see parsers/typescript.ts header for the full list).`,
                );
            }
            return endpoints;
        },
    };
}

export function tsExtractEndpoints(filePath: string): EndpointMapping[] {
    const source = fs.readFileSync(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    const methodChainPrefix = tsDeriveMethodChain(filePath);
    const endpoints: EndpointMapping[] = [];

    // The fetcher pattern is on the private `__methodName` impl. The public
    // method just delegates to it; parsing the private one avoids matching
    // both halves. Strip the `__` prefix when emitting the chain.
    function visit(node: ts.Node) {
        if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
            const name = node.name.text;
            if (name.startsWith("__") && node.body) {
                const info = tsExtractFetcherCall(node.body);
                if (info) {
                    const mapping: EndpointMapping = {
                        httpMethod: info.method,
                        httpPath: normalizePathParams(info.path),
                        methodChain: [...methodChainPrefix, name.slice(2)],
                        methodName: name.slice(2),
                    };
                    const wrapperKey = info.bodyExpr && tsBodyWrapperKey(node.body, info.bodyExpr);
                    if (wrapperKey) mapping.bodyWrapperKey = wrapperKey;
                    endpoints.push(mapping);
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return endpoints;
}

// Walks the body of `__methodName` looking for the fetcher object literal that
// carries both `url: core.url.join(<base>, <path>)` and `method: "<METHOD>"`.
// Returns null when the body doesn't contain a recognizable fetcher call
// (e.g. helper methods that aren't endpoint impls).
//
// `bodyExpr` is the identifier passed to the fetcher's `body:` — either
// `request` (the whole request object is the wire body) or a local pulled out
// of `request` by the method's destructuring. Captured only from the fetcher
// literal (the one carrying `method:`) so the error-handler literal's
// `body: _response.error.body` doesn't leak in. Undefined when there's no body
// or it isn't a bare identifier (e.g. a serializer call we can't trace).
function tsExtractFetcherCall(
    body: ts.Block,
): { method: string; path: string; bodyExpr?: string } | null {
    let method: string | null = null;
    let pathStr: string | null = null;
    let bodyExpr: string | undefined;

    function visit(node: ts.Node) {
        if (ts.isObjectLiteralExpression(node)) {
            const isFetcherLiteral = node.properties.some(
                (p) =>
                    ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) &&
                    p.name.text === "method" && ts.isStringLiteral(p.initializer),
            );
            for (const prop of node.properties) {
                if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
                if (prop.name.text === "method" && ts.isStringLiteral(prop.initializer)) {
                    method = prop.initializer.text;
                } else if (prop.name.text === "url") {
                    const p = tsExtractUrlPath(prop.initializer);
                    if (p !== null) pathStr = p;
                } else if (isFetcherLiteral && prop.name.text === "body" && ts.isIdentifier(prop.initializer)) {
                    bodyExpr = prop.initializer.text;
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
    if (!method || !pathStr) return null;
    return { method, path: pathStr.startsWith("/") ? pathStr : "/" + pathStr, bodyExpr };
}

// Determines whether the fetcher body lives under a key of the request object
// (Fern's request wrapper) or is the request object itself. Fern inlines the
// body straight into `request` unless the endpoint also carries header/query
// members; then the body sits under a dedicated key alongside them. Reading
// the method's `const { ... } = request;` destructuring tells us which:
//   `body: request`  → the whole request IS the body          → no wrapper
//   `body: _body` from `body: _body` (property binding)        → wrapper key `body`
//   `body: _body` from `..._body`    (rest binding)            → inlined remainder, no wrapper
// Returns the wrapper key, or undefined when the body is inlined / untraceable.
function tsBodyWrapperKey(methodBody: ts.Block, bodyExpr: string): string | undefined {
    if (bodyExpr === "request") return undefined;
    let key: string | undefined;
    let done = false; // set once the binding for `bodyExpr` is found, so the walk stops

    function visit(node: ts.Node) {
        if (done) return;
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === "request" &&
            ts.isObjectBindingPattern(node.name)
        ) {
            for (const el of node.name.elements) {
                if (!ts.isIdentifier(el.name) || el.name.text !== bodyExpr) continue;
                done = true;
                // `..._body` (rest) leaves `key` unset — the body is the inlined
                // remainder of `request`, with no wrapper. Otherwise the key is
                // the bound property name (`body: _body`) or, for a shorthand
                // `{ body }`, the local name itself.
                if (!el.dotDotDotToken) {
                    key = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName))
                        ? el.propertyName.text
                        : el.name.text;
                }
                return;
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(methodBody);
    return key;
}

// `url:` can take several shapes across Fern TS codegen generations:
//   - `core.url.join(<base>, <pathArg>)` — current Fern; recurse into the
//     last argument (the path)
//   - `"https://example/agent/create"` — older Fern test/example shape
//   - `` `https://example/agent/${id}` `` — older Fern with substitutions
//   - `` `${baseUrl}/agent/${id}` `` — baseUrl-substitution prefix style
// In every shape, the path portion is whatever remains after stripping a
// leading `http(s)://host` or a leading `{placeholder}` (baseUrl substitution).
function tsExtractUrlPath(node: ts.Expression): string | null {
    const full = tsRenderUrlExpression(node);
    if (full === null) return null;
    // Strip any leading absolute-URL prefix (real or substituted host) so
    // we're left with the path portion the OpenAPI template encodes.
    const stripped = full.replace(/^https?:\/\/[^/]+/, "").replace(/^\{[^}]+\}/, "");
    return stripped || null;
}

// Renders the url-property expression as a string, replacing `${expr}` spans
// with `{name}` placeholders. Returns null if the expression isn't a form we
// understand (e.g. a bare identifier reference to a precomputed URL).
function tsRenderUrlExpression(node: ts.Expression): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    if (ts.isTemplateExpression(node)) {
        let out = node.head.text;
        for (const span of node.templateSpans) {
            out += `{${tsExtractPathParamName(span.expression)}}` + span.literal.text;
        }
        return out;
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
        return tsRenderUrlExpression(node.arguments[node.arguments.length - 1]);
    }
    return null;
}

function tsExtractPathParamName(expr: ts.Expression): string {
    // The Fern emit is `core.url.encodePathParam(<ident>)`. Anything else
    // means a newer/older codegen, in which case we fall back to the raw
    // expression text — better to surface a recognizable token than to
    // silently drop the param.
    if (ts.isCallExpression(expr) && expr.arguments.length > 0) {
        const arg = expr.arguments[0];
        if (ts.isIdentifier(arg)) return arg.text;
    }
    if (ts.isIdentifier(expr)) return expr.text;
    return expr.getText();
}

function tsDeriveMethodChain(filePath: string): string[] {
    const normalized = filePath.replace(/\\/g, "/");
    const match = normalized.match(/\/resources\/(.+?)\/client\/Client\.ts$/);
    if (!match) return [];
    return match[1].split("/resources/");
}
