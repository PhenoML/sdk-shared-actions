import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import type {
    BodySchema,
    EndpointMapping,
    RenderSchema,
    SchemaField,
    SchemaFieldKind,
} from "../types";

// Per-field info pulled from a Fern-generated TS request interface. Field
// ordering follows interface declaration order; required/optional is the
// `?:` syntax on each property.
export interface TsFieldInfo {
    jsonKey: string;        // Interface property name (matches the wire key)
    typeText: string;       // Raw type expression, e.g. `string`, `Type.Resource`
    isOptional: boolean;    // `name?:` syntax → field has no required marker
}

export interface TsInterfaceInfo {
    interfaceName: string;
    filePath: string;
    fields: TsFieldInfo[];
    // String-literal union values declared inline in the same file under
    // `export namespace XxxRequest { export const Foo = {...} as const; ... }`
    // — keyed by the type name (e.g. "Resource"). Used to surface enum-like
    // fields with their wire values.
    enums: Map<string, string[]>;
}

// Across-call caches keep the TS parser efficient: Client.ts is parsed
// once per file (vs. once per endpoint), and shared request interfaces are
// each parsed only once.
export interface TsParseCaches {
    sourceFiles: Map<string, ts.SourceFile>;
    interfaces: Map<string, TsInterfaceInfo | null>;
}

export function createTsParseCaches(): TsParseCaches {
    return { sourceFiles: new Map(), interfaces: new Map() };
}

// Build a RenderSchema for one TS endpoint. Reads the request interface,
// strips header-only fields (identified by the private __method's
// destructuring), and emits an object-literal BodySchema. callTemplate has
// the shape `client.<chain>.<method>({ {{__body__}} })` — TS Fern clients
// always pass a single request object.
export function buildTsRenderSchema(
    endpoint: EndpointMapping,
    clientFile: string,
    caches?: TsParseCaches,
): RenderSchema {
    const callTemplate = tsCallTemplate(endpoint);
    const fallback: RenderSchema = { callTemplate, params: [] };

    const sigInfo = tsExtractMethodSignatureInfo(clientFile, endpoint.methodName, caches);
    if (!sigInfo || !sigInfo.requestTypeName) return fallback;

    const interfaceFile = tsResolveRequestInterfacePath(clientFile, sigInfo.requestTypeName);
    if (!interfaceFile) return fallback;

    const info = tsParseRequestInterfaceCached(interfaceFile, caches);
    if (!info) return fallback;

    const fields: SchemaField[] = [];
    for (const f of info.fields) {
        if (sigInfo.headerKeys.has(f.jsonKey)) continue;
        fields.push(tsToSchemaField(f, info));
    }
    if (fields.length === 0) return fallback;

    return { callTemplate, params: [], body: { fieldSeparator: ", ", fields } };
}

function tsParseRequestInterfaceCached(
    filePath: string,
    caches?: TsParseCaches,
): TsInterfaceInfo | null {
    if (!caches) return tsParseRequestInterface(filePath);
    if (caches.interfaces.has(filePath)) return caches.interfaces.get(filePath)!;
    const info = tsParseRequestInterface(filePath);
    caches.interfaces.set(filePath, info);
    return info;
}

function tsGetSourceFile(filePath: string, caches?: TsParseCaches): ts.SourceFile | null {
    if (caches?.sourceFiles.has(filePath)) return caches.sourceFiles.get(filePath)!;
    if (!fs.existsSync(filePath)) return null;
    const source = fs.readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    caches?.sourceFiles.set(filePath, sf);
    return sf;
}

function tsCallTemplate(endpoint: EndpointMapping): string {
    const accessors = endpoint.methodChain.slice(0, -1);
    const chainStr = ["client", ...accessors].join(".") + "." + endpoint.methodName;
    return `${chainStr}({ {{__body__}} })`;
}

function tsToSchemaField(f: TsFieldInfo, owner: TsInterfaceInfo): SchemaField {
    const field: SchemaField = {
        jsonKey: f.jsonKey,
        // Always quote — hyphenated keys (e.g. `X-Foo`) require it.
        fieldTemplate: `${JSON.stringify(f.jsonKey)}: {{value}}`,
        kind: tsInferKind(f.typeText, owner.enums),
        required: !f.isOptional,
    };

    if (field.kind === "list") {
        const inner = tsUnwrapList(f.typeText);
        field.items = {
            jsonKey: "",
            fieldTemplate: "{{value}}",
            kind: tsInferKind(inner, owner.enums),
            required: true,
        };
    } else if (field.kind === "enum") {
        field.enumValues = tsResolveEnumValues(f.typeText, owner);
    }
    return field;
}

// Map a TS type expression to a SchemaFieldKind. Recognizes the shapes Fern
// emits: primitives, `T[]` / `Array<T>` / `ReadonlyArray<T>` lists, namespace
// references that resolve to local enum-shaped `as const` objects.
export function tsInferKind(
    typeText: string,
    enums: Map<string, string[]>,
): SchemaFieldKind {
    const t = typeText.trim();
    if (/^string$/.test(t) || /^Date$/.test(t)) return "string";
    if (/^number$/.test(t)) return "number";
    if (/^boolean$/.test(t)) return "boolean";
    if (/\[\s*\]$/.test(t)) return "list";
    if (/^(Array|ReadonlyArray)\s*</.test(t)) return "list";
    // `Type.Foo` patterns resolve to either an enum (namespace const) or a
    // nested type. We look up Foo in the local enums map first.
    const lastSeg = t.split(".").pop()?.split("<")[0]?.trim() ?? "";
    if (enums.has(lastSeg)) return "enum";
    return "object";
}

function tsUnwrapList(typeText: string): string {
    const t = typeText.trim();
    const square = t.match(/^([\s\S]+?)\[\s*\]\s*$/);
    if (square) return square[1].trim();
    const generic = t.match(/^(?:Array|ReadonlyArray)\s*<\s*([\s\S]+)\s*>\s*$/);
    if (generic) return generic[1].trim();
    return "unknown";
}

function tsResolveEnumValues(typeText: string, owner: TsInterfaceInfo): string[] | undefined {
    const lastSeg = typeText.split(".").pop()?.split("<")[0]?.trim() ?? "";
    return owner.enums.get(lastSeg);
}

// Extract, for one public method in a Client.ts:
//   - the request type name (`phenoml.tools.CohortRequest` → "CohortRequest")
//   - header keys destructured out of `request` in the private __method
// Both signals are needed to compute the body composition.
export function tsExtractMethodSignatureInfo(
    clientFile: string,
    methodName: string,
    caches?: TsParseCaches,
): { requestTypeName: string | null; headerKeys: Set<string> } | null {
    const sf = tsGetSourceFile(clientFile, caches);
    if (!sf) return null;
    const source = sf.getFullText();

    let requestTypeName: string | null = null;
    const headerKeys = new Set<string>();

    function visit(node: ts.Node) {
        if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
            if (node.name.text === methodName) {
                const firstParam = node.parameters[0];
                if (firstParam?.type) {
                    requestTypeName = tsTypeLastSegment(firstParam.type, source);
                }
            }
            if (node.name.text === `__${methodName}` && node.body) {
                tsCollectDestructuredHeaderKeys(node.body, headerKeys);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return { requestTypeName, headerKeys };
}

// Walk a private __method body for `const {"X-Header": id, ..._body} =
// request;` patterns and record the destructured (non-rest) keys.
function tsCollectDestructuredHeaderKeys(body: ts.Block, out: Set<string>) {
    function visit(node: ts.Node) {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isObjectBindingPattern(node.name) &&
            node.initializer &&
            ts.isIdentifier(node.initializer) &&
            node.initializer.text === "request"
        ) {
            for (const el of node.name.elements) {
                if (el.dotDotDotToken) continue; // The `..._body` rest binding
                // Property name is the wire key (with hyphens etc.) when
                // present; otherwise it matches the local binding name.
                const wire = el.propertyName
                    ? tsPropertyNameText(el.propertyName)
                    : (ts.isIdentifier(el.name) ? el.name.text : null);
                if (wire) out.add(wire);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
}

function tsPropertyNameText(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name)) return name.text;
    if (ts.isNumericLiteral(name)) return name.text;
    return null;
}

// Pull the last segment of a TS qualified type reference. `phenoml.tools.CohortRequest`
// → "CohortRequest". Generics and unions fall through unchanged — those
// aren't request types we know how to resolve.
function tsTypeLastSegment(typeNode: ts.TypeNode, source: string): string | null {
    if (ts.isTypeReferenceNode(typeNode)) {
        let n: ts.EntityName = typeNode.typeName;
        while (ts.isQualifiedName(n)) n = n.right;
        if (ts.isIdentifier(n)) return n.text;
    }
    // Fallback: scrape the rightmost identifier from the raw text.
    const text = source.slice(typeNode.pos, typeNode.end).trim();
    const last = text.match(/(\w+)\s*$/);
    return last ? last[1] : null;
}

// Locate the request interface file given the client file and a type name.
// Fern places request types at `<dirname(client)>/requests/<Name>.ts`.
export function tsResolveRequestInterfacePath(clientFile: string, requestTypeName: string): string | null {
    const requestsDir = path.join(path.dirname(clientFile), "requests");
    const candidate = path.join(requestsDir, requestTypeName + ".ts");
    if (fs.existsSync(candidate)) return candidate;
    return null;
}

// Parse a Fern-generated TS request interface file via the compiler API.
// Captures field declarations + their (`?:`) optional markers and any local
// `as const`-shaped enums (Fern emits these inside a sibling namespace).
export function tsParseRequestInterface(filePath: string): TsInterfaceInfo | null {
    if (!fs.existsSync(filePath)) return null;
    const source = fs.readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

    let interfaceName: string | null = null;
    const fields: TsFieldInfo[] = [];
    const enums = new Map<string, string[]>();

    function visit(node: ts.Node) {
        if (ts.isInterfaceDeclaration(node)) {
            if (!interfaceName) interfaceName = node.name.text;
            for (const member of node.members) {
                if (!ts.isPropertySignature(member)) continue;
                const jsonKey = tsPropertyNameText(member.name);
                if (!jsonKey) continue;
                const typeText = member.type ? source.slice(member.type.pos, member.type.end).trim() : "unknown";
                fields.push({
                    jsonKey,
                    typeText,
                    isOptional: !!member.questionToken,
                });
            }
        }
        if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
            // Sibling namespace: `export namespace XxxRequest { export const Foo = { ... } as const; }`
            for (const stmt of node.body.statements) {
                if (!ts.isVariableStatement(stmt)) continue;
                for (const decl of stmt.declarationList.declarations) {
                    if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
                    const literal = tsExtractAsConstObject(decl.initializer);
                    if (literal) enums.set(decl.name.text, literal);
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    if (!interfaceName) return null;
    return { interfaceName, filePath, fields, enums };
}

// Recognize `{ Foo: "foo", Bar: "bar" } as const` and return the literal
// values. Anything else returns null.
function tsExtractAsConstObject(node: ts.Expression): string[] | null {
    let inner = node;
    if (ts.isAsExpression(inner)) inner = inner.expression;
    if (!ts.isObjectLiteralExpression(inner)) return null;
    const values: string[] = [];
    for (const prop of inner.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        if (ts.isStringLiteral(prop.initializer)) values.push(prop.initializer.text);
    }
    return values.length > 0 ? values : null;
}
