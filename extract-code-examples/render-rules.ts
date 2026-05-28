import type {
    BodySchema,
    EndpointMapping,
    Language,
    ParamField,
    RenderRules,
    RenderSchema,
    ResolvedSchema,
    SchemaField,
    SchemaFieldKind,
    SpecEndpoint,
} from "./types";
import { camelToSnake, pascalCase, screamingSnake, snakeToCamel, stripSchemaPrefix } from "./utils";

export const RENDER_RULES_BY_LANGUAGE: Record<Language, RenderRules> = {
    typescript: {
        stringLiteral: `"{{value}}"`,
        numberLiteral: `{{value}}`,
        trueLiteral: "true",
        falseLiteral: "false",
        nullLiteral: "null",
        listLiteral: `[{{items}}]`,
        listSeparator: ", ",
    },
    python: {
        stringLiteral: `"{{value}}"`,
        numberLiteral: `{{value}}`,
        trueLiteral: "True",
        falseLiteral: "False",
        nullLiteral: "None",
        listLiteral: `[{{items}}]`,
        listSeparator: ", ",
    },
    java: {
        stringLiteral: `"{{value}}"`,
        numberLiteral: `{{value}}`,
        trueLiteral: "true",
        falseLiteral: "false",
        nullLiteral: "null",
        // Fern's Java codegen emits `Arrays.asList(...)` for list literals.
        listLiteral: `Arrays.asList({{items}})`,
        listSeparator: ", ",
    },
};

export function buildRenderSchema(
    spec: SpecEndpoint,
    mapping: EndpointMapping,
    language: Language,
): RenderSchema {
    // OpenAPI doesn't require `parameters` to be declared in URL order, but
    // `pathParamNames` from the parser is URL-ordered, and TS/Java consumers
    // pass positional values matching the URL/method signature. Align both
    // by URL placeholder order so `params[i]` and `pathParamNames[i]` refer
    // to the same path slot.
    const params = paramsInUrlOrder(spec);

    let body = spec.requestSchema ? buildBodySchema(spec.requestSchema, language, mapping) : undefined;
    if (spec.queryParams.length > 0) {
        // Query params travel as SDK kwargs/options alongside body fields —
        // Fern emits a single call signature for both. Append them so the
        // rendered call gets `client.X.list(tag="...")` for a query-only
        // endpoint and `client.X.create(name="...", tag="...")` for combined.
        //
        // Exception: a passthrough body (e.g. a JSON Patch array as the wire
        // payload) can't take named-field neighbors — the rendered call would
        // emit `{ [...patches...], "tags": "..." }` which isn't valid TS or
        // Python syntax. Real Fern doesn't generate this combination today;
        // if it ever does, the warning surfaces it for investigation.
        if (body && isPassthroughBody(body)) {
            console.error(
                `  WARNING: endpoint ${spec.httpMethod} ${spec.httpPath} has a passthrough body ` +
                `and ${spec.queryParams.length} query parameter(s) — query params dropped from render. ` +
                `Fern doesn't generate this combination; verify the spec or extend render-rules.ts if it's intentional.`,
            );
        } else {
            const queryFields = spec.queryParams.map((p) =>
                buildField(p.name, p.schema ?? {}, p.required === true, language, mapping),
            );
            body = body
                ? { ...body, fields: [...body.fields, ...queryFields] }
                : { fieldSeparator: separatorFor(language), fields: queryFields };
        }
    }

    // Java has no syntax for free-floating field setters — without a request
    // class to wrap them, fall back to a no-arg call signature. The body
    // catalog stays in the schema for docs/UI; only the call slot is dropped.
    //
    // This is parser-miss recovery, NOT a routine path. Real Fern Java wraps
    // every query-param endpoint in a request class (`list(AgentListRequest,
    // RequestOptions)`), so the parser's last-non-RequestOptions heuristic
    // always finds the class. Fern Java has no codegen pattern that emits
    // scalar query args directly as method parameters. If this guard fires,
    // either codegen changed shape or the parser's signature matcher missed
    // a case — the warning surfaces it for investigation.
    const javaBodyUnrenderable =
        language === "java" && body !== undefined && !isPassthroughBody(body) && !mapping.requestClassName;
    if (javaBodyUnrenderable) {
        console.error(
            `  WARNING: Java endpoint ${mapping.methodChain.join(".")} ` +
            `has body/query fields but no request class — call signature won't include them`,
        );
    }

    const callTemplate = buildCallTemplate(mapping, params, javaBodyUnrenderable ? undefined : body, language);

    const schema: RenderSchema = { callTemplate, params };
    if (body) schema.body = body;
    return schema;
}

function buildCallTemplate(
    mapping: EndpointMapping,
    params: ParamField[],
    body: BodySchema | undefined,
    language: Language,
): string {
    // Python accepts path params as kwargs (`delete(id="...")`) — matches the
    // reference.md style. TS/Java take them positionally because that's all
    // the language permits. The Python kwarg label is the SDK's local
    // identifier (sourced from the parser), which may differ from the spec
    // param name when OpenAPI uses camelCase (`codeID` → `code_id`).
    const pathArgs = language === "python"
        ? params.map((p, i) => `${pythonPathKwargLabel(mapping, p, i)}={{${p.name}}}`)
        : params.map((p) => `{{${p.name}}}`);

    const accessorParts = mapping.methodChain.slice(0, -1)
        .map((s) => (language === "java" ? `${s}()` : s));
    const accessors = accessorParts.join(".");
    const chain = accessors ? `client.${accessors}.${mapping.methodName}` : `client.${mapping.methodName}`;

    const bodySlot = body ? bodySlotFor(body, language, mapping) : undefined;
    const args = [...pathArgs, ...(bodySlot ? [bodySlot] : [])];
    return `${chain}(${args.join(", ")})`;
}

// SDK-source identifier for the i'th path param, with a fall-back to the spec
// name when the parser didn't surface one. The fall-back keeps older fixtures
// (and SDKs whose codegen we haven't fully matched) working — they get a
// kwarg that mirrors OpenAPI rather than a runtime error.
function pythonPathKwargLabel(mapping: EndpointMapping, param: ParamField, index: number): string {
    return mapping.pathParamNames?.[index] ?? param.name;
}

// Returns path params ordered to match the URL's placeholder sequence. The
// URL template (`spec.httpPath`) is the authoritative ordering — that's what
// the SDK method signature mirrors. Matches by snake_cased name since
// normalizePathParams has already snake_cased the URL placeholders while
// the spec param entries keep their raw OpenAPI form.
function paramsInUrlOrder(spec: SpecEndpoint): ParamField[] {
    const declared = spec.pathParams.map<ParamField>((p) => ({
        name: p.name,
        kind: inferKind(p.schema),
    }));
    const urlOrder = [...spec.httpPath.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (urlOrder.length === 0) return declared;
    const byKey = new Map(declared.map((p) => [camelToSnake(p.name), p]));
    const ordered: ParamField[] = [];
    const seen = new Set<ParamField>();
    for (const key of urlOrder) {
        const hit = byKey.get(key);
        if (hit && !seen.has(hit)) {
            ordered.push(hit);
            seen.add(hit);
        }
    }
    // Carry along anything `parameters` declared that doesn't appear in the
    // URL (rare/malformed, but don't silently drop data the spec asserted).
    for (const p of declared) if (!seen.has(p)) ordered.push(p);
    return ordered;
}

function bodySlotFor(body: BodySchema, language: Language, mapping: EndpointMapping): string {
    // A passthrough body's value IS the whole wire body (a JSON Patch array,
    // for example). Wrapping it in `{ ... }` (TS) or `RequestClass.builder()`
    // (Java) would emit invalid code; both fall back to bare `{{__body__}}`.
    //
    // Python is the exception: its SDK takes the body as a named kwarg, so the
    // bare body would either chain a positional after kwargs
    // (`method(id="x", [...])` — invalid Python) or drop the parameter
    // entirely. We use the kwarg name the parser observed on the method
    // signature, falling back to `request` (the Fern convention) only when
    // the parser didn't extract anything.
    if (isPassthroughBody(body)) {
        if (language !== "python") return "{{__body__}}";
        const kwarg = mapping.bodyKwargForPassthrough ?? "request";
        return `${kwarg}={{__body__}}`;
    }
    if (language === "java" && mapping.requestClassName) return javaBuilderWrap(mapping.requestClassName);
    if (language === "typescript") return "{ {{__body__}} }";
    return "{{__body__}}";
}

function isPassthroughBody(body: BodySchema): boolean {
    return body.fields.length === 1 && body.fields[0].passthroughBody === true;
}

function javaBuilderWrap(className: string): string {
    return `${className}.builder(){{__body__}}.build()`;
}

function buildBodySchema(schema: ResolvedSchema, language: Language, mapping?: EndpointMapping): BodySchema {
    // No named properties to iterate — synthesize a passthrough field so the
    // consumer can render the curated example without per-key templates.
    // Covers (a) non-object roots (array, scalar), (b) top-level `oneOf`
    // discriminated unions with no wrapping object, and (c) `type: "object"`
    // schemas that carry `oneOf`/`anyOf` instead of declared properties.
    const properties = schema.properties ?? {};
    if (Object.keys(properties).length === 0) {
        const kind = inferKind(schema);
        const field: SchemaField = {
            jsonKey: "",
            fieldTemplate: "{{value}}",
            kind,
            required: true,
            passthroughBody: true,
        };
        if (kind === "list" && schema.items) {
            field.items = buildListItemField(schema.items, language);
        }
        return { fieldSeparator: separatorFor(language), fields: [field] };
    }

    const required = new Set(schema.required ?? []);
    const fields: SchemaField[] = [];

    // Required first (Java staged builders enforce this; TS/Python adopt the
    // same order for cross-language consistency), then optional in spec order.
    // `mapping` is only threaded into top-level fields — nested objects render
    // as inline literals (dict/object/builder), not as named SDK kwargs.
    for (const name of schema.required ?? []) {
        if (name in properties) fields.push(buildField(name, properties[name], true, language, mapping));
    }
    for (const [name, prop] of Object.entries(properties)) {
        if (!required.has(name)) fields.push(buildField(name, prop, false, language, mapping));
    }
    return { fieldSeparator: separatorFor(language), fields };
}

function buildField(
    jsonKey: string,
    prop: ResolvedSchema,
    required: boolean,
    language: Language,
    mapping?: EndpointMapping,
): SchemaField {
    return populateNested({
        jsonKey,
        fieldTemplate: fieldTemplateFor(jsonKey, language, mapping),
        kind: inferKind(prop),
        required,
    }, prop, language);
}

function buildListItemField(items: ResolvedSchema, language: Language): SchemaField {
    return populateNested({
        jsonKey: "",
        fieldTemplate: "{{value}}",
        kind: inferKind(items),
        required: true,
    }, items, language);
}

// Fills in kind-specific extras (items, enum values, nested sub-schemas) on
// a freshly-built field. Shared by buildField and buildListItemField since
// the descent rules are identical — only the seed (`jsonKey`/`fieldTemplate`)
// differs.
function populateNested(field: SchemaField, prop: ResolvedSchema, language: Language): SchemaField {
    if (field.kind === "enum" && prop.enum) {
        field.enumValues = prop.enum.map(String);
        const enumConstants = enumConstantsFor(prop, language);
        if (enumConstants) field.enumConstants = enumConstants;
    }
    if (field.kind === "list" && prop.items) {
        field.items = buildListItemField(prop.items, language);
    }
    // Populate `nested` for $ref'd object types in every language that uses
    // it. Python is excluded by README contract — nested objects there render
    // as untyped dict literals — so omitting `nested` is the documented
    // signal. Java needs a builder envelope on the wrap; TS needs a `{ ... }`
    // envelope so list items and nested fields produce valid object literals.
    if (field.kind === "object" && prop.$refName && prop.properties && language !== "python") {
        const wrap = language === "java"
            ? javaBuilderWrapFor(prop.$refName)
            : "{ {{__body__}} }";
        // Java without a confident class name (e.g. ambiguous nested ref) has
        // no usable builder envelope — `.foo("bar")` outside a builder doesn't
        // compile. Skip nested so the consumer renders the example value
        // verbatim instead of emitting broken setter chains.
        if (wrap !== null) {
            const nested = buildBodySchema(prop, language);
            nested.wrap = wrap;
            field.nested = nested;
        }
    }
    return field;
}

function javaBuilderWrapFor(refName: string): string | null {
    const className = stripSchemaPrefix(refName);
    return className ? javaBuilderWrap(className) : null;
}

function inferKind(schema: ResolvedSchema | undefined): SchemaFieldKind {
    if (!schema) return "object";
    if (schema.enum) return "enum";
    if (schema.type === "string") return "string";
    if (schema.type === "number" || schema.type === "integer") return "number";
    if (schema.type === "boolean") return "boolean";
    if (schema.type === "array") return "list";
    // oneOf / anyOf without a concrete `type` falls through to object so the
    // example value (which carries the actual variant shape) is rendered as
    // a literal. The consumer dispatches on the data, not the schema.
    return "object";
}

function separatorFor(language: Language): string {
    return language === "java" ? "" : ", ";
}

function fieldTemplateFor(jsonKey: string, language: Language, mapping?: EndpointMapping): string {
    if (language === "python") {
        // Python kwarg name = the identifier the SDK's method signature
        // exposes for this wire key (read off the source by the parser).
        // When the parser doesn't surface one (older fixtures, unknown
        // codegen pattern) the wire key is used verbatim — that gives the
        // user a visible artifact to fix rather than a silent miscompile
        // from a snake_case heuristic.
        const kwarg = mapping?.bodyKwargByJsonKey?.[jsonKey] ?? jsonKey;
        return `${kwarg}={{value}}`;
    }
    if (language === "typescript") return `${JSON.stringify(jsonKey)}: {{value}}`;
    // Java: snake_case JSON keys become camelCase setters.
    return `.${snakeToCamel(jsonKey)}({{value}})`;
}

function enumConstantsFor(
    prop: ResolvedSchema,
    language: Language,
): Record<string, string> | undefined {
    // Python accepts the wire string directly; no typed constant needed.
    if (language === "python") return undefined;
    if (!prop.enum || !prop.$refName) return undefined;
    // Ambiguous schema names (multiple PascalCase segments) can't be mapped
    // to a single SDK identifier — fall back to plain string rendering, which
    // type-checks against the enum's `keyof typeof` literal union.
    const className = stripSchemaPrefix(prop.$refName);
    if (!className) return undefined;
    const out: Record<string, string> = {};
    for (const v of prop.enum) {
        const value = String(v);
        out[value] = language === "java"
            ? `${className}.${screamingSnake(value)}`
            : `${className}.${pascalCase(value)}`;
    }
    return out;
}
