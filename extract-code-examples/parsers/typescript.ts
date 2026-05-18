import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type { EndpointMapping, LanguageParser, TestExample } from "../types";
import { buildTsRenderSchema, createTsParseCaches } from "./typescript-schema";
import { findFiles, normalizePathParams } from "../utils";

export function createTypeScriptParser(): LanguageParser {
    return {
        language: "typescript",

        parseEndpoints(rootDir: string): EndpointMapping[] {
            const clientFiles = findFiles(path.join(rootDir, "src/api/resources"), /\/client\/Client\.ts$/);
            const endpoints: EndpointMapping[] = [];
            const caches = createTsParseCaches();
            for (const file of clientFiles) {
                const fileEndpoints = tsExtractEndpoints(file);
                for (const ep of fileEndpoints) {
                    ep.renderSchema = buildTsRenderSchema(ep, file, caches);
                }
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

export function tsExtractEndpoints(filePath: string): EndpointMapping[] {
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
                    const method = tsFindEnclosingMethod(node);
                    if (method && method.name && ts.isIdentifier(method.name)) {
                        const publicName = method.name.text.replace(/^__/, "");
                        // `core.Stream<...>` in the return type marks an SSE method.
                        const returnTypeText = method.type ? source.slice(method.type.pos, method.type.end) : "";
                        const isStreaming = /\bStream\s*</.test(returnTypeText);
                        const entry: EndpointMapping = {
                            httpMethod: httpMethodArg.text,
                            httpPath: normalizePathParams(httpPathArg.text),
                            methodChain: [...methodChainPrefix, publicName],
                            methodName: publicName,
                        };
                        if (isStreaming) entry.isStreaming = true;
                        endpoints.push(entry);
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

function tsFindEnclosingMethod(node: ts.Node): ts.MethodDeclaration | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
        if (ts.isMethodDeclaration(current)) return current;
        current = current.parent;
    }
    return null;
}

export function tsExtractTestExamples(filePath: string): TestExample[] {
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
