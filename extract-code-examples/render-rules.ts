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
import { pascalCase, screamingSnake, snakeToCamel, stripSchemaPrefix } from "./utils";

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
    const params = spec.pathParams.map<ParamField>((p) => ({
        name: p.name,
        kind: inferKind(p.schema),
    }));

    let body = spec.requestSchema ? buildBodySchema(spec.requestSchema, language) : undefined;
    if (spec.queryParams.length > 0) {
        // Query params travel as SDK kwargs/options alongside body fields —
        // Fern emits a single call signature for both. Append them so the
        // rendered call gets `client.X.list(tag="...")` for a query-only
        // endpoint and `client.X.create(name="...", tag="...")` for combined.
        const queryFields = spec.queryParams.map((p) =>
            buildField(p.name, p.schema ?? {}, p.required === true, language),
        );
        if (body) {
            body = { ...body, fields: [...body.fields, ...queryFields] };
        } else {
            body = { fieldSeparator: separatorFor(language), fields: queryFields };
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
    // the language permits.
    const pathArgs = language === "python"
        ? params.map((p) => `${p.name}={{${p.name}}}`)
        : params.map((p) => `{{${p.name}}}`);

    const accessorParts = mapping.methodChain.slice(0, -1)
        .map((s) => (language === "java" ? `${s}()` : s));
    const accessors = accessorParts.join(".");
    const chain = accessors ? `client.${accessors}.${mapping.methodName}` : `client.${mapping.methodName}`;

    const bodySlot = body ? bodySlotFor(body, language, mapping.requestClassName) : undefined;
    const args = [...pathArgs, ...(bodySlot ? [bodySlot] : [])];
    return `${chain}(${args.join(", ")})`;
}

function bodySlotFor(body: BodySchema, language: Language, requestClassName: string | undefined): string {
    // A passthrough body's value IS the whole wire body (a JSON Patch array,
    // for example). Wrapping it in `{ ... }` (TS) or `RequestClass.builder()`
    // (Java) would emit invalid code; both fall back to bare `{{__body__}}`.
    if (isPassthroughBody(body)) return "{{__body__}}";
    if (language === "java" && requestClassName) return javaBuilderWrap(requestClassName);
    if (language === "typescript") return "{ {{__body__}} }";
    return "{{__body__}}";
}

function isPassthroughBody(body: BodySchema): boolean {
    return body.fields.length === 1 && body.fields[0].passthroughBody === true;
}

function javaBuilderWrap(className: string): string {
    return `${className}.builder(){{__body__}}.build()`;
}

function buildBodySchema(schema: ResolvedSchema, language: Language): BodySchema {
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
    for (const name of schema.required ?? []) {
        if (name in properties) fields.push(buildField(name, properties[name], true, language));
    }
    for (const [name, prop] of Object.entries(properties)) {
        if (!required.has(name)) fields.push(buildField(name, prop, false, language));
    }
    return { fieldSeparator: separatorFor(language), fields };
}

function buildField(
    jsonKey: string,
    prop: ResolvedSchema,
    required: boolean,
    language: Language,
): SchemaField {
    return populateNested({
        jsonKey,
        fieldTemplate: fieldTemplateFor(jsonKey, language),
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

function fieldTemplateFor(jsonKey: string, language: Language): string {
    if (language === "python") return `${jsonKey}={{value}}`;
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

