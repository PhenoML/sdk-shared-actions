import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import type {
    BodySchema,
    EndpointMapping,
    ParamField,
    RenderSchema,
    SchemaField,
    SchemaFieldKind,
} from "../types";
import { camelToSnake } from "../utils";

// Per-field info pulled from a Fern-generated TS request interface. Field
// ordering follows interface declaration order; required/optional is the
// `?:` syntax on each property.
export interface TsFieldInfo {
    jsonKey: string;        // Interface property name (matches the wire key)
    typeText: string;       // Raw type expression, e.g. `string`, `Type.Resource`
    isOptional: boolean;    // `name?:` syntax → field has no required marker
}

// One entry from a namespace-const `as const` object. The key is the
// PascalCase identifier (`Assistant`); the wire value is the string the
// key maps to (`"assistant"`). Both halves are needed so a TS renderer
// can emit `AgentChatRequest.Role.Assistant` instead of a bare string —
// the latter doesn't satisfy the namespace-typed property's signature.
export interface TsEnumEntry {
    key: string;
    wireValue: string;
}

export interface TsInterfaceInfo {
    interfaceName: string;
    filePath: string;
    fields: TsFieldInfo[];
    // String-literal union values declared inline in the same file under
    // `export namespace XxxRequest { export const Foo = {...} as const; ... }`
    // — keyed by the type name (e.g. "Role"). Entries carry both the
    // PascalCase const key and its wire value so the schema can surface
    // both UI dropdown values AND `<Namespace>.<Type>.<Key>` rendering
    // expressions.
    enums: Map<string, TsEnumEntry[]>;
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
// strips header-only fields (from the private __method's destructuring),
// and emits an object-literal BodySchema. Fern TS signatures place path
// params positionally BEFORE the request-object kwarg
// (`searchSemantic(codesystem, { text: ... })`); the callTemplate
// interleaves `{{name}}` placeholders accordingly.
export function buildTsRenderSchema(
    endpoint: EndpointMapping,
    clientFile: string,
    caches?: TsParseCaches,
): RenderSchema {
    const sigInfo = tsExtractMethodSignatureInfo(clientFile, endpoint.methodName, caches);
    const params: ParamField[] = (sigInfo?.positionalParams ?? []).map((p) => ({
        name: camelToSnake(p.name),
        kind: p.kind,
    }));
    const callTemplate = tsCallTemplate(endpoint, params, !!sigInfo?.requestTypeName);
    const fallback: RenderSchema = { callTemplate, params };

    if (!sigInfo?.requestTypeName) return fallback;

    const interfaceFile = tsResolveRequestInterfacePath(clientFile, sigInfo.requestTypeName);
    if (!interfaceFile) return fallback;

    const info = tsParseRequestInterfaceCached(interfaceFile, caches);
    if (!info) return fallback;

    const fields: SchemaField[] = [];
    for (const f of info.fields) {
        if (sigInfo.headerKeys.has(f.jsonKey)) continue;
        const sf = tsToSchemaField(f, info, caches);
        if (sigInfo.passthroughBodyKey === f.jsonKey) sf.passthroughBody = true;
        fields.push(sf);
    }
    if (fields.length === 0) return fallback;

    return { callTemplate, params, body: { fieldSeparator: ", ", fields } };
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

function tsCallTemplate(endpoint: EndpointMapping, params: ParamField[], hasBody: boolean): string {
    const accessors = endpoint.methodChain.slice(0, -1);
    const chainStr = ["client", ...accessors].join(".") + "." + endpoint.methodName;
    const positional = params.map((p) => `{{${p.name}}}`);
    const args = hasBody ? [...positional, "{ {{__body__}} }"] : positional;
    return `${chainStr}(${args.join(", ")})`;
}

function tsToSchemaField(
    f: TsFieldInfo,
    owner: TsInterfaceInfo,
    caches?: TsParseCaches,
    visited?: Set<string>,
): SchemaField {
    const field: SchemaField = {
        jsonKey: f.jsonKey,
        // Always quote — hyphenated keys (e.g. `X-Foo`) require it.
        fieldTemplate: `${JSON.stringify(f.jsonKey)}: {{value}}`,
        kind: tsInferKind(f.typeText, owner.enums),
        required: !f.isOptional,
    };

    if (field.kind === "list") {
        field.items = tsListItemField(tsUnwrapList(f.typeText), owner, caches, visited);
    } else if (field.kind === "enum") {
        applyTsEnum(field, f.typeText, owner);
    } else if (field.kind === "object") {
        const nested = tsResolveNestedInterface(f.typeText, owner, caches, visited);
        if (nested) field.nested = tsBuildNestedBody(nested, caches, visited);
    }
    return field;
}

// Populate enum-related fields on a SchemaField whose type resolved to a
// namespace-const declaration. `enumValues` lists wire strings for UI
// dropdowns; `enumConstants` maps each wire value to its TS expression
// (e.g. `AgentChatRequest.Role.Assistant`) so the renderer can satisfy
// the namespace-typed property without a typecheck failure.
function applyTsEnum(field: SchemaField, typeText: string, owner: TsInterfaceInfo): void {
    const lastSeg = typeText.split(".").pop()?.split("<")[0]?.trim() ?? "";
    const entries = owner.enums.get(lastSeg);
    if (!entries) return;
    field.enumValues = entries.map((e) => e.wireValue);
    // The TS expression is the property's full type reference plus the
    // const key (`AgentChatRequest.Role` + `.Assistant`). `typeText` already
    // carries any namespace prefix.
    field.enumConstants = Object.fromEntries(
        entries.map((e) => [e.wireValue, `${typeText.trim()}.${e.key}`]),
    );
}

// Synthesize a SchemaField for one list element. Mirrors the top-level
// kind decisions so nested arrays of objects (e.g. `fhir_resources:
// Resource[]`) carry their full type catalog.
function tsListItemField(
    itemType: string,
    owner: TsInterfaceInfo,
    caches?: TsParseCaches,
    visited?: Set<string>,
): SchemaField {
    const kind = tsInferKind(itemType, owner.enums);
    const item: SchemaField = {
        jsonKey: "",
        fieldTemplate: "{{value}}",
        kind,
        required: true,
    };
    if (kind === "list") {
        item.items = tsListItemField(tsUnwrapList(itemType), owner, caches, visited);
    } else if (kind === "enum") {
        applyTsEnum(item, itemType, owner);
    } else if (kind === "object") {
        const nested = tsResolveNestedInterface(itemType, owner, caches, visited);
        if (nested) item.nested = tsBuildNestedBody(nested, caches, visited);
    }
    return item;
}

function tsBuildNestedBody(
    info: TsInterfaceInfo,
    caches?: TsParseCaches,
    visited?: Set<string>,
): BodySchema {
    // Build a path-scoped set that includes the interface we're about to
    // descend into. Copying instead of mutating the caller's set means two
    // sibling fields of the same type each get a fresh resolution attempt.
    const path = new Set(visited);
    path.add(info.interfaceName);
    const fields = info.fields.map((f) => tsToSchemaField(f, info, caches, path));
    // Object-literal envelope so the consumer doesn't emit a bare property
    // list when this body is used as an inline value (e.g. inside a list
    // of objects: `[{ name: "x" }, { name: "y" }]`).
    return { fieldSeparator: ", ", fields, wrap: "{ {{__body__}} }" };
}

// Resolve a type-name reference inside an interface to a parsed
// TsInterfaceInfo on disk. Walks Fern's standard layout: a request
// interface at `<resource>/client/requests/Foo.ts` references nested
// types under `<resource>/types/Bar.ts`. Returns null when the type is
// local, a primitive, or unresolvable. `visited` breaks cycles.
function tsResolveNestedInterface(
    typeText: string,
    owner: TsInterfaceInfo,
    caches?: TsParseCaches,
    visited?: Set<string>,
): TsInterfaceInfo | null {
    const simple = typeText.trim().split(".").pop()?.split("<")[0]?.trim();
    if (!simple) return null;
    if (visited?.has(simple)) return null;
    if (owner.enums.has(simple)) return null;
    const ownerDir = path.dirname(owner.filePath);
    // Probe Fern's known layouts in order of specificity. The two-dot
    // candidates handle `client/requests/Foo.ts` → `<resource>/types/Bar.ts`.
    const candidates = [
        path.join(ownerDir, simple + ".ts"),
        path.join(ownerDir, "..", "types", simple + ".ts"),
        path.join(ownerDir, "..", "..", "types", simple + ".ts"),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            return tsParseRequestInterfaceCached(c, caches);
        }
    }
    return null;
}

// Map a TS type expression to a SchemaFieldKind. Recognizes the shapes Fern
// emits: primitives, `T[]` / `Array<T>` / `ReadonlyArray<T>` lists, namespace
// references that resolve to local enum-shaped `as const` objects.
export function tsInferKind(
    typeText: string,
    enums: Map<string, TsEnumEntry[]>,
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


export interface TsSignatureInfo {
    // Trailing request-object parameter's type name (`phenoml.tools.CohortRequest`
    // → "CohortRequest"). Null when the method has no body parameter
    // (e.g. a path-param-only GET with no query bundle).
    requestTypeName: string | null;
    // Path/query params declared positionally BEFORE the request object,
    // in signature order. Fern places these first for endpoints whose URL
    // template embeds path variables.
    positionalParams: { name: string; kind: SchemaFieldKind }[];
    // Property keys destructured out of `request` in the private __method
    // body — those ship as headers and must be excluded from body.fields.
    headerKeys: Set<string>;
    // Wire key whose value IS the wire body (not `body[jsonKey]`), set on
    // the `const { ..., body: _body } = request; ... body: _body` no-rest
    // pattern. Feeds `SchemaField.passthroughBody`.
    passthroughBodyKey: string | null;
}

// Extract path params, request type, and header destructuring for one
// public method in a Client.ts. The request type is the LAST non-options
// parameter; everything before it is positional (kind inferred from the
// type expression). RequestOptions trailing params are ignored.
export function tsExtractMethodSignatureInfo(
    clientFile: string,
    methodName: string,
    caches?: TsParseCaches,
): TsSignatureInfo | null {
    const sf = tsGetSourceFile(clientFile, caches);
    if (!sf) return null;
    const source = sf.getFullText();

    const info: TsSignatureInfo = {
        requestTypeName: null,
        positionalParams: [],
        headerKeys: new Set(),
        passthroughBodyKey: null,
    };

    function visit(node: ts.Node) {
        if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
            if (node.name.text === methodName) {
                classifyTsSignatureParams(node.parameters, source, info);
            }
            if (node.name.text === `__${methodName}` && node.body) {
                tsCollectRequestBindings(node.body, info);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return info;
}

// Drop trailing `requestOptions?` then treat the last remaining param as
// the request body (when its type ends in "Request"). All earlier params
// are positional path/query args.
function classifyTsSignatureParams(
    params: ts.NodeArray<ts.ParameterDeclaration>,
    source: string,
    out: TsSignatureInfo,
) {
    const eligible = params.filter((p) => {
        const typeName = p.type ? tsTypeLastSegment(p.type, source) : null;
        return typeName !== "RequestOptions";
    });
    if (eligible.length === 0) return;

    const last = eligible[eligible.length - 1];
    const lastTypeName = last.type ? tsTypeLastSegment(last.type, source) : null;
    const lastIsBody = lastTypeName !== null && /Request$/.test(lastTypeName);

    const positionalParams = lastIsBody ? eligible.slice(0, -1) : eligible;
    for (const p of positionalParams) {
        if (!ts.isIdentifier(p.name)) continue;
        const typeText = p.type ? source.slice(p.type.pos, p.type.end).trim() : "string";
        out.positionalParams.push({ name: p.name.text, kind: tsInferParamKind(typeText) });
    }
    if (lastIsBody) out.requestTypeName = lastTypeName;
}

// Path/query params are scalar; default to "string" when the type isn't
// one of the few primitives Fern surfaces positionally.
function tsInferParamKind(typeText: string): SchemaFieldKind {
    const t = typeText.trim();
    if (/^number$/.test(t)) return "number";
    if (/^boolean$/.test(t)) return "boolean";
    return "string";
}

// Walk a private __method body for two Fern patterns:
//
//   const { "X-Header": id, ..._body } = request;
//   ...
//   body: _body,                       // fetcher arg
//
// → `id`'s wire key is a header, `_body` (and the rest of `request`) is
// the wire body. This is the common case.
//
//   const { "X-Header": id, body: _body } = request;
//   ...
//   body: _body,                       // fetcher arg
//
// → `id`'s wire key is a header, and the interface's `body` property's
// value IS the wire body (e.g. a JSON Patch array on PATCH endpoints).
// Mark that wire key as the passthrough body key.
//
// Destructures without rest AND without a matching body arg (e.g. `const
// { version } = request` for query params) are left alone — flagging
// `version` as a header would drop it from the body schema entirely.
function tsCollectRequestBindings(body: ts.Block, out: TsSignatureInfo) {
    // Single AST pass: collect the fetcher's `body: <ident>` arg AND every
    // `const {...} = request` destructure. We can't classify destructures
    // until `bodyArgIdent` is known, so defer classification until after
    // the walk.
    let bodyArgIdent: string | null = null;
    const destructures: ts.ObjectBindingPattern[] = [];
    function visit(node: ts.Node) {
        if (
            ts.isPropertyAssignment(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "body" &&
            ts.isIdentifier(node.initializer)
        ) {
            bodyArgIdent = node.initializer.text;
        }
        if (
            ts.isVariableDeclaration(node) &&
            ts.isObjectBindingPattern(node.name) &&
            node.initializer &&
            ts.isIdentifier(node.initializer) &&
            node.initializer.text === "request"
        ) {
            destructures.push(node.name);
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
    for (const pattern of destructures) {
        classifyTsRequestDestructure(pattern, bodyArgIdent, out);
    }
}

function classifyTsRequestDestructure(
    pattern: ts.ObjectBindingPattern,
    bodyArgIdent: string | null,
    out: TsSignatureInfo,
): void {
    const restEl = pattern.elements.find((el) => !!el.dotDotDotToken);
    // The identifier passed to the fetcher's `body:` arg may match an
    // explicit destructure element; when it does, that element's wire key
    // is the passthrough body field. Only relevant in the no-rest case
    // (a `...rest` binding always represents the body in Fern's output).
    const passthroughEl = !restEl && bodyArgIdent
        ? pattern.elements.find(
              (el) => !el.dotDotDotToken && ts.isIdentifier(el.name) && el.name.text === bodyArgIdent,
          )
        : undefined;
    // Neither pattern matched → query-param destructure (e.g. `const
    // { version } = request`); leave its keys alone or they vanish from
    // the body schema.
    if (!restEl && !passthroughEl) return;
    for (const el of pattern.elements) {
        if (el.dotDotDotToken) continue;
        const wire = tsBindingWireKey(el);
        if (!wire) continue;
        if (el === passthroughEl) {
            out.passthroughBodyKey = wire;
        } else {
            out.headerKeys.add(wire);
        }
    }
}

function tsBindingWireKey(el: ts.BindingElement): string | null {
    if (el.propertyName) return tsPropertyNameText(el.propertyName);
    if (ts.isIdentifier(el.name)) return el.name.text;
    return null;
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

    // Discriminated-union files declare `type Foo = A | B | ...` plus a
    // same-named namespace whose variants share a string-literal discriminator
    // and pull the rest of their fields from `extends`. Flattening all
    // variants would emit N copies of the shared discriminator and drop every
    // inherited field. Bail; the caller leaves `nested` unset on the field so
    // the consumer renders the example body verbatim.
    if (tsIsDiscriminatedUnionFile(sf)) return null;

    let interfaceName: string | null = null;
    const fields: TsFieldInfo[] = [];
    const enums = new Map<string, TsEnumEntry[]>();

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

// Matches `type Foo = A | B | C` (at least one branch is a TypeReference)
// when the file has NO top-level `export interface`. Fern's discriminated
// unions keep their variant interfaces inside the same-named namespace,
// not at the top level; a sibling helper union (e.g. `Model | undefined`)
// next to a primary interface would otherwise be misread as a discriminated
// union and the interface schema lost.
function tsIsDiscriminatedUnionFile(sf: ts.SourceFile): boolean {
    let hasUnionAlias = false;
    for (const stmt of sf.statements) {
        if (ts.isInterfaceDeclaration(stmt)) return false;
        if (!ts.isTypeAliasDeclaration(stmt)) continue;
        if (!ts.isUnionTypeNode(stmt.type)) continue;
        if (stmt.type.types.some((t) => ts.isTypeReferenceNode(t))) hasUnionAlias = true;
    }
    return hasUnionAlias;
}

// Recognize `{ Foo: "foo", Bar: "bar" } as const` and return the entries
// as (key, wireValue) pairs. Returns null when the expression doesn't
// match the namespace-const shape.
function tsExtractAsConstObject(node: ts.Expression): TsEnumEntry[] | null {
    let inner = node;
    if (ts.isAsExpression(inner)) inner = inner.expression;
    if (!ts.isObjectLiteralExpression(inner)) return null;
    const entries: TsEnumEntry[] = [];
    for (const prop of inner.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = tsPropertyNameText(prop.name);
        if (!key) continue;
        if (ts.isStringLiteral(prop.initializer)) {
            entries.push({ key, wireValue: prop.initializer.text });
        }
    }
    return entries.length > 0 ? entries : null;
}
