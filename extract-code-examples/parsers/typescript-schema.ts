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
    // The trailing param is the body when EITHER its type name resolves
    // (the common case) OR the private method forwards it verbatim — the
    // latter catches anonymous types like inline `JsonPatchOperation[]`
    // arrays where `requestTypeName` can't be extracted but the param
    // still IS the body.
    const hasBody = !!sigInfo && (!!sigInfo.requestTypeName || sigInfo.wholeParamIsBody);

    if (!sigInfo || !hasBody) {
        return { callTemplate: tsCallTemplate(endpoint, params, false, false), params };
    }

    const typeFile = sigInfo.requestTypeName
        ? tsResolveRequestTypePath(clientFile, sigInfo.requestTypeName)
        : null;
    const info = typeFile ? tsParseRequestInterfaceCached(typeFile, caches) : null;

    // No interface available — either the file lives under types/ and is a
    // type alias (e.g. `type JsonPatch = JsonPatchOperation[]`), the
    // request is a discriminated union we bailed on, or the param's type
    // is anonymous (inline array / object literal — no file to resolve).
    // When the param's full value IS the wire body, synthesize a single
    // passthrough field so the consumer renders the example body verbatim
    // instead of dropping it. The call template skips `{ }` wrapping in
    // this branch — the rendered body literal (`[...]` or `{...}`)
    // supplies its own delimiters.
    if (!info) {
        if (!sigInfo.wholeParamIsBody) {
            return { callTemplate: tsCallTemplate(endpoint, params, true, false), params };
        }
        const callTemplate = tsCallTemplate(endpoint, params, true, true);
        const synthetic = tsSyntheticPassthroughField(typeFile, sigInfo.requestTypeText, clientFile, caches);
        return { callTemplate, params, body: { fieldSeparator: "", fields: [synthetic] } };
    }

    const callTemplate = tsCallTemplate(endpoint, params, true, false);
    const fallback: RenderSchema = { callTemplate, params };
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

// Build a synthetic SchemaField that tells the consumer to render the
// example body verbatim. Used when the request param's type is not a
// parseable interface — a type alias to an array (JSON Patch), a
// discriminated union, or an inline anonymous type. The field's jsonKey
// is empty (passthroughBody short-circuits the `jsonKey in body`
// filter); `kind` carries enough type info that lists still recurse
// into typed item rendering.
//
// `typeFile`: the file that declares the named request type (if any) —
// used to resolve type aliases like `type JsonPatch = T[]`.
// `inlineTypeText`: the raw type expression on the param when the type
// has no resolvable file (inline `T[]` or anonymous object). Either
// signal yielding an array item type produces a `kind: "list"` field;
// otherwise we fall back to `kind: "object"` (untyped fallback).
function tsSyntheticPassthroughField(
    typeFile: string | null,
    inlineTypeText: string | null,
    clientFile: string,
    caches?: TsParseCaches,
): SchemaField {
    const aliased = typeFile ? tsReadArrayAliasItem(typeFile) : null;
    const inlineItem = !aliased && inlineTypeText ? tsExtractInlineArrayItem(inlineTypeText) : null;
    const itemType = aliased ?? inlineItem;
    if (itemType) {
        // Synthetic owner: anchored at the alias file when we have one, or
        // at the client file's parent so inline-array nested resolution
        // walks the same `requests/` / `types/` directories the real
        // parser would.
        const ownerFile = typeFile ?? path.join(path.dirname(clientFile), "__synthetic__.ts");
        const owner: TsInterfaceInfo = {
            interfaceName: "<synthetic>",
            filePath: ownerFile,
            fields: [],
            enums: new Map(),
        };
        return {
            jsonKey: "",
            fieldTemplate: "{{value}}",
            kind: "list",
            required: true,
            items: tsListItemField(itemType, owner, caches),
            passthroughBody: true,
        };
    }
    // Untyped fallback: TS/Python renderers treat `kind: "object"` with no
    // `nested` as "emit a language-native object literal" — exactly what
    // we want for a discriminated-union body or an anonymous inline type.
    return {
        jsonKey: "",
        fieldTemplate: "{{value}}",
        kind: "object",
        required: true,
        passthroughBody: true,
    };
}

// Recognize inline array type syntax in a raw type expression and return
// the element type text. Mirrors `tsReadArrayAliasItem` but operates on
// the signature's raw text rather than a declaration file. Returns null
// for non-array shapes (named types, unions, objects).
export function tsExtractInlineArrayItem(typeText: string): string | null {
    const t = typeText.trim();
    const squareMatch = t.match(/^([\s\S]+?)\[\s*\]\s*$/);
    if (squareMatch) return squareMatch[1].trim();
    const genericMatch = t.match(/^(?:Array|ReadonlyArray)\s*<\s*([\s\S]+)\s*>\s*$/);
    if (genericMatch) return genericMatch[1].trim();
    return null;
}

// Recognize `export type Foo = Bar[]` / `Array<Bar>` / `ReadonlyArray<Bar>`
// and return the inner item type text. Returns null for non-array aliases
// (unions, primitives, intersections).
function tsReadArrayAliasItem(filePath: string): string | null {
    if (!fs.existsSync(filePath)) return null;
    const source = fs.readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    for (const stmt of sf.statements) {
        if (!ts.isTypeAliasDeclaration(stmt)) continue;
        const t = stmt.type;
        if (ts.isArrayTypeNode(t)) {
            return source.slice(t.elementType.pos, t.elementType.end).trim();
        }
        if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
            const name = t.typeName.text;
            if ((name === "Array" || name === "ReadonlyArray") && t.typeArguments?.length === 1) {
                const arg = t.typeArguments[0];
                return source.slice(arg.pos, arg.end).trim();
            }
        }
    }
    return null;
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

function tsCallTemplate(
    endpoint: EndpointMapping,
    params: ParamField[],
    hasBody: boolean,
    passthroughOnly: boolean,
): string {
    const accessors = endpoint.methodChain.slice(0, -1);
    const chainStr = ["client", ...accessors].join(".") + "." + endpoint.methodName;
    const positional = params.map((p) => `{{${p.name}}}`);
    // `passthroughOnly`: the param's full value IS the wire body, rendered
    // as a self-delimiting literal (`[...]`, `{...}`). Wrapping in extra
    // braces would produce `{ [...] }` — broken syntax.
    const bodySlot = passthroughOnly ? "{{__body__}}" : "{ {{__body__}} }";
    const args = hasBody ? [...positional, bodySlot] : positional;
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
    // (e.g. a path-param-only GET with no query bundle) AND null when
    // the param IS the body but its type is anonymous (e.g. an inline
    // `JsonPatchOperation[]` array). The latter case is distinguished
    // from "no body" by `wholeParamIsBody`.
    requestTypeName: string | null;
    // Raw text of the trailing-param's type expression — set whenever the
    // trailing param is the body, regardless of whether the type has a
    // resolvable name. Used to detect inline array syntax (`T[]` /
    // `Array<T>`) when `requestTypeName` is null so a synthetic
    // passthrough body can still recurse into the item type.
    requestTypeText: string | null;
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
    // True when the private __method passes the trailing public param
    // straight to the fetcher (`body: <paramName>` with no destructure of
    // that param). The whole param's value IS the wire body — used to
    // recognize bodies whose type is an alias (e.g. `JsonPatch =
    // JsonPatchOperation[]`) or a discriminated union that doesn't end in
    // `Request`. Drives the passthrough-only render path.
    wholeParamIsBody: boolean;
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

    // Two-pass collection: __method body tells us whether a param is used
    // directly as the wire body (`body: paramName`) — a signal the public-
    // signature classifier needs to widen "is body" past the `*Request`
    // type-name heuristic (e.g. `request: phenoml.agent.JsonPatch`).
    let publicMethod: ts.MethodDeclaration | null = null;
    let privateBody: ts.Block | null = null;
    function find(node: ts.Node) {
        if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
            if (node.name.text === methodName) publicMethod = node;
            if (node.name.text === `__${methodName}` && node.body) privateBody = node.body;
        }
        ts.forEachChild(node, find);
    }
    find(sf);
    if (!publicMethod) return null;

    const bodyInfo = privateBody ? tsCollectPrivateBodyInfo(privateBody) : { bodyArgIdent: null, destructures: [] };

    const info: TsSignatureInfo = {
        requestTypeName: null,
        requestTypeText: null,
        positionalParams: [],
        headerKeys: new Set(),
        passthroughBodyKey: null,
        wholeParamIsBody: false,
    };

    classifyTsSignatureParams((publicMethod as ts.MethodDeclaration).parameters, source, info, bodyInfo);
    for (const pattern of bodyInfo.destructures) {
        classifyTsRequestDestructure(pattern, bodyInfo.bodyArgIdent, info);
    }
    return info;
}

interface TsPrivateBodyInfo {
    // Identifier passed to the fetcher's `body:` arg. Either a destructure
    // local (`_body`) or the param itself (`request`).
    bodyArgIdent: string | null;
    // Every `const {...} = request` destructure in declaration order — we
    // classify each one after the walk so we have `bodyArgIdent` first.
    destructures: ts.ObjectBindingPattern[];
}

// Drop trailing `requestOptions?` then treat the last remaining param as
// the request body when EITHER its type name ends in "Request" OR the
// private __method forwards that param verbatim as the wire body
// (`body: <paramName>`, no destructure). The latter case catches type-
// alias bodies like `request: phenoml.agent.JsonPatch` where the name
// suffix doesn't advertise it. All earlier params are positional
// path/query args.
function classifyTsSignatureParams(
    params: ts.NodeArray<ts.ParameterDeclaration>,
    source: string,
    out: TsSignatureInfo,
    bodyInfo: TsPrivateBodyInfo,
) {
    const eligible = params.filter((p) => {
        const typeName = p.type ? tsTypeLastSegment(p.type, source) : null;
        return typeName !== "RequestOptions";
    });
    if (eligible.length === 0) return;

    const last = eligible[eligible.length - 1];
    const lastTypeName = last.type ? tsTypeLastSegment(last.type, source) : null;
    const lastParamName = ts.isIdentifier(last.name) ? last.name.text : null;
    const lastNameEndsInRequest = lastTypeName !== null && /Request$/.test(lastTypeName);
    const lastIsPassthroughBody =
        lastParamName !== null && bodyInfo.bodyArgIdent === lastParamName;
    const lastIsBody = lastNameEndsInRequest || lastIsPassthroughBody;

    const positionalParams = lastIsBody ? eligible.slice(0, -1) : eligible;
    for (const p of positionalParams) {
        if (!ts.isIdentifier(p.name)) continue;
        const typeText = p.type ? source.slice(p.type.pos, p.type.end).trim() : "string";
        out.positionalParams.push({ name: p.name.text, kind: tsInferParamKind(typeText) });
    }
    if (lastIsBody) {
        out.requestTypeName = lastTypeName;
        out.requestTypeText = last.type ? source.slice(last.type.pos, last.type.end).trim() : null;
        // Mark whenever the param's full value IS the wire body (the private
        // method forwards it without destructuring). The synthetic-passthrough
        // fallback in buildTsRenderSchema only fires when the type ALSO fails
        // to resolve to a parseable interface, so this stays a no-op for
        // ordinary whole-object bodies like `request: CohortRequest`.
        out.wholeParamIsBody = lastIsPassthroughBody;
    }
}

// Path/query params are scalar; default to "string" when the type isn't
// one of the few primitives Fern surfaces positionally.
function tsInferParamKind(typeText: string): SchemaFieldKind {
    const t = typeText.trim();
    if (/^number$/.test(t)) return "number";
    if (/^boolean$/.test(t)) return "boolean";
    return "string";
}

// Walk a private __method body and gather the raw signals the signature
// classifier and destructure classifier need:
//
//   const { "X-Header": id, ..._body } = request;
//   body: _body,                       // → `_body` is the body identifier;
//                                       //   `id` is a header.
//
//   const { "X-Header": id, body: _body } = request;
//   body: _body,                       // → `id` is a header; the interface's
//                                       //   `body` property's value IS the
//                                       //   wire body (JSON Patch array on
//                                       //   FHIR-style PATCH endpoints).
//
//   body: request,                     // (no destructure)
//                                       // → the whole `request` param value
//                                       //   IS the wire body. Flagged via
//                                       //   `bodyArgIdent === paramName` in
//                                       //   the signature classifier.
//
// Destructures without rest AND without a matching body arg (e.g. `const
// { version } = request` for query params) are left alone by the caller —
// flagging `version` as a header would drop it from the body schema entirely.
function tsCollectPrivateBodyInfo(body: ts.Block): TsPrivateBodyInfo {
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
    return { bodyArgIdent, destructures };
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

// Locate the file declaring the request type — usually an interface in
// `client/requests/<Name>.ts`, but Fern places discriminated unions and
// type aliases under `<resource>/types/<Name>.ts` instead (e.g.
// `FhirProviderAddAuthConfigRequest` is a union, `JsonPatch` is a type
// alias). Try both layouts so the schema builder can still produce a
// passthrough render for those.
function tsResolveRequestTypePath(clientFile: string, requestTypeName: string): string | null {
    const fromRequests = tsResolveRequestInterfacePath(clientFile, requestTypeName);
    if (fromRequests) return fromRequests;
    const typesDir = path.join(path.dirname(clientFile), "..", "types");
    const candidate = path.join(typesDir, requestTypeName + ".ts");
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
