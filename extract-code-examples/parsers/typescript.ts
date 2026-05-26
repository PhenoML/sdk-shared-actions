import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type { EndpointMapping, LanguageParser } from "../types";
import { findFiles, normalizePathParams } from "../utils";

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
                    endpoints.push({
                        httpMethod: info.method,
                        httpPath: normalizePathParams(info.path),
                        methodChain: [...methodChainPrefix, name.slice(2)],
                        methodName: name.slice(2),
                    });
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
function tsExtractFetcherCall(body: ts.Block): { method: string; path: string } | null {
    let method: string | null = null;
    let pathStr: string | null = null;

    function visit(node: ts.Node) {
        if (ts.isObjectLiteralExpression(node)) {
            for (const prop of node.properties) {
                if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
                if (prop.name.text === "method" && ts.isStringLiteral(prop.initializer)) {
                    method = prop.initializer.text;
                } else if (prop.name.text === "url") {
                    const p = tsExtractUrlPath(prop.initializer);
                    if (p !== null) pathStr = p;
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
    if (!method || !pathStr) return null;
    return { method, path: pathStr.startsWith("/") ? pathStr : "/" + pathStr };
}

// `url:` is typically `core.url.join(<base>, <pathArg>)` where pathArg is
// either a string literal ("agent/create") or a template literal
// (`agent/${core.url.encodePathParam(id)}`). The last argument is the
// path; the base arg is environment plumbing we don't care about.
function tsExtractUrlPath(node: ts.Expression): string | null {
    if (!ts.isCallExpression(node)) return null;
    const args = node.arguments;
    if (args.length === 0) return null;
    const last = args[args.length - 1];
    if (ts.isStringLiteral(last) || ts.isNoSubstitutionTemplateLiteral(last)) return last.text;
    if (ts.isTemplateExpression(last)) {
        // Rebuild the template, replacing each `${core.url.encodePathParam(x)}`
        // span with `{x}` so the result matches the OpenAPI path template.
        let out = last.head.text;
        for (const span of last.templateSpans) {
            out += `{${tsExtractPathParamName(span.expression)}}` + span.literal.text;
        }
        return out;
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
