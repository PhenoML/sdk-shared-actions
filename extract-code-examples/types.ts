export type Language = "typescript" | "python" | "java";

// Per-language mapping from (httpMethod, httpPath) to the SDK call. Produced
// by reading generated SDK source — the spec doesn't carry SDK naming.
export interface EndpointMapping {
    httpMethod: string;
    httpPath: string; // OpenAPI-style template, e.g., /agent/{id}
    methodChain: string[]; // e.g., ["agent", "create"]
    methodName: string; // e.g., "create"
    // Java only. Name of the request class the SDK method accepts
    // (e.g. "CohortRequest"). Used by render-rules to build the callTemplate's
    // builder wrapper. Undefined for endpoints with no body parameter.
    requestClassName?: string;
    // SDK-side identifiers for the method's path params, in URL order. The
    // language-specific renderer uses these for the call's positional/kwarg
    // argument labels — bypassing assumptions about Fern's case conversion
    // (e.g. Python `code_id` for OpenAPI's `codeID`).
    pathParamNames?: string[];
    // SDK-side kwarg name for each JSON request-body field, keyed by the wire
    // (OpenAPI) JSON key. Lets the Python renderer emit
    // `resource_type=value` for an OpenAPI field named `resourceType`,
    // sourced from the actual SDK signature rather than a snake_case heuristic.
    bodyKwargByJsonKey?: Record<string, string>;
    // SDK-side kwarg name when the wire body is a passthrough (JSON Patch
    // array, untyped object, discriminated union with no wrapping object,
    // etc.) — Fern's Python codegen typically uses `request`, but we read it
    // off the source rather than hard-coding the convention.
    bodyKwargForPassthrough?: string;
    // TS only. Request-object key the SDK nests the wire body under. Fern's
    // TS codegen inlines the body directly into the request object — UNLESS
    // the endpoint also carries header/query members, in which case the body
    // lives under a dedicated key (conventionally `body`) alongside them
    // (e.g. FHIR `create(id, path, { body: <resource> })`). The renderer wraps
    // the body slot in this key so the generated call sets the field the SDK
    // actually reads. Undefined when the body is inlined.
    bodyWrapperKey?: string;
}

// Per-endpoint data extracted from the OpenAPI spec.
export interface SpecEndpoint {
    httpMethod: string;
    httpPath: string;
    pathParams: SpecParam[];
    // Query parameters. Surfaced separately so the renderer can fold them
    // into the SDK call's keyword/options args alongside body fields — Fern
    // SDKs accept query params as the same call-site kwargs as body fields.
    queryParams: SpecParam[];
    // Resolved request body schema (with $refs inlined). Absent for endpoints
    // with no request body. The $refName field is preserved when the body
    // is a $ref so the renderer knows the type name.
    requestSchema?: ResolvedSchema;
    // Verbatim curated example from the spec. Used directly as request.body
    // in the manifest — the discriminator (and any other fixed fields the
    // schema doesn't enforce) is part of the example.
    requestExample?: unknown;
    // Verbatim response example, picked from the first 2xx response with
    // an `application/json` content-type. Null for streaming endpoints
    // (we surface streaming=true instead).
    responseExample?: unknown;
    // True when the success response is `text/event-stream`. Set so docs
    // can show an "event stream" badge instead of a JSON body.
    isStreaming: boolean;
}

export interface SpecParam {
    name: string;
    required?: boolean;
    schema?: ResolvedSchema;
}

// OpenAPI schema with $refs already resolved. `$refName` is set on a schema
// that originated from a $ref so the renderer knows the named type — needed
// for Java's `Tag.builder()...build()` nested envelopes.
export interface ResolvedSchema {
    type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
    format?: string;
    required?: string[];
    properties?: Record<string, ResolvedSchema>;
    additionalProperties?: ResolvedSchema | boolean;
    items?: ResolvedSchema;
    enum?: unknown[];
    oneOf?: ResolvedSchema[];
    allOf?: ResolvedSchema[];
    anyOf?: ResolvedSchema[];
    $refName?: string;
}

export interface CodeExample {
    httpMethod: string;
    httpPath: string;
    request: {
        body: unknown | null;
    };
    response: {
        body: unknown | null;
        // Set on SSE endpoints so docs can render an "event stream" badge
        // instead of treating the (null) body as a missing-example signal.
        streaming?: boolean;
    };
    // Dynamic-render schema. Lets a consumer (e.g. docs playground) regenerate
    // the SDK call for any user-provided body without re-encoding language
    // semantics. See RenderSchema.
    render?: RenderSchema;
}

// Per-example structure that lets a single consumer-side algorithm render
// the SDK call for arbitrary user input. Combined with the manifest-level
// renderRules, it replaces ad-hoc string templating with a uniform
// "schema + value substitution" model.
export interface RenderSchema {
    // Call wrapper string. Contains:
    //   {{paramName}}   placeholder for each entry in `params`
    //   {{__body__}}    placeholder for the joined body field renderings
    //                   (omitted when `body` is undefined)
    callTemplate: string;
    // Path and query params, ordered to match `callTemplate` placeholders.
    params: ParamField[];
    // Absent for endpoints with no request body (e.g. GETs without query input).
    body?: BodySchema;
}

export interface ParamField {
    name: string;
    kind: SchemaFieldKind;
    enumValues?: string[];
    enumConstants?: Record<string, string>;
}

export interface BodySchema {
    // Required fields first (Java staged builders enforce this; TS/Python
    // report it for fidelity), then optional in spec declaration order.
    fields: SchemaField[];
    // Joiner inserted between rendered fields: "" for Java (each field
    // starts with "."), ", " for TS/Python.
    fieldSeparator: string;
    // Language-specific envelope when this schema is rendered as an inline
    // value (i.e. nested inside a parent field). Contains a `{{__body__}}`
    // placeholder for the joined body. Absent on the top-level body — that
    // case is wrapped by the RenderSchema's `callTemplate`.
    wrap?: string;
}

export interface SchemaField {
    jsonKey: string;
    // Per-field render template containing a `{{value}}` placeholder.
    fieldTemplate: string;
    kind: SchemaFieldKind;
    required: boolean;
    // Set when `kind === "object"`. Lets the consumer recurse into the
    // nested type without needing language-specific object-rendering logic.
    nested?: BodySchema;
    // Set when `kind === "list"`. Describes a single list item.
    items?: SchemaField;
    enumValues?: string[];
    // Per-wire-value language-specific constant expression. Populated when
    // the language requires a typed reference (Java's `AgentRole.ASSISTANT`,
    // TS's `AgentChatRequest.Role.Assistant`); absent for Python.
    enumConstants?: Record<string, string>;
    // When true, the field's value IS the entire wire request body, not
    // `body[jsonKey]`. Set when the request type is a type-alias/array/union
    // (no wrapper object). Common on PATCH endpoints whose wire body is a
    // top-level JSON Patch array.
    passthroughBody?: boolean;
}

export type SchemaFieldKind =
    | "string"
    | "number"
    | "boolean"
    | "list"
    | "object"
    | "enum";

// Language-wide rendering constants. The consumer uses these to format any
// JSON value into a language-native literal. One algorithm works across all
// SDK languages because every language-specific quirk lives here.
export interface RenderRules {
    stringLiteral: string;     // e.g. `"{{value}}"`
    numberLiteral: string;     // e.g. `{{value}}`
    trueLiteral: string;       // "true" | "True"
    falseLiteral: string;      // "false" | "False"
    nullLiteral: string;       // "null" | "None"
    listLiteral: string;       // Java: `Arrays.asList({{items}})`; TS/Python: `[{{items}}]`
    listSeparator: string;     // typically ", "
}

export interface Manifest {
    metadata: {
        language: string;
        packageName: string;
        sdkVersion: string;
        specCommit: string;
        generatorName: string;
    };
    // Language-wide constants for the consumer-side renderer.
    renderRules: RenderRules;
    examples: Record<string, CodeExample>;
}

export interface LanguageParser {
    language: Language;
    parseEndpoints(rootDir: string): EndpointMapping[];
}

export interface FernMetadata {
    generatorName: string;
    sdkVersion: string;
    originGitCommit: string;
}
