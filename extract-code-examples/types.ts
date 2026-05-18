export type Language = "typescript" | "python" | "java";

export interface EndpointMapping {
    httpMethod: string;
    httpPath: string; // OpenAPI-style template, e.g., /agent/{id}
    methodChain: string[]; // e.g., ["agent", "create"]
    methodName: string; // e.g., "create"
    // Python-only: maps SDK kwarg name → JSON field name, derived from the
    // raw client's `json={"jsonKey": kwargName, ...}` dict. Used both to
    // exclude header/query/path kwargs from derived bodies and to emit the
    // correct (possibly aliased) wire field names. Undefined for TS/Java
    // (their parsers read body from a test literal) or when the raw client
    // doesn't use a `json={...}` dict literal (e.g., `json=body_var`).
    bodyParamMap?: Record<string, string>;
    // Python-only: literal JSON-field values hard-coded in the raw client's
    // `json={...}` dict (e.g., `"resourceType": "Bundle"`). Merged into the
    // derived body alongside kwarg-sourced fields so the manifest reflects
    // the full payload the SDK sends, not just the kwarg-provided portion.
    bodyLiterals?: Record<string, unknown>;
    // Python-only: when the raw client passes a single kwarg directly as
    // the JSON body (`json=<kwarg>` or `json=wrapper(object_=<kwarg>, ...)`),
    // the entire HTTP body IS that kwarg's value — not a dict that wraps it
    // under the kwarg's name. Common for PATCH endpoints whose body is a
    // raw JSON Patch array.
    bodyPassthroughKwarg?: string;
    // True for SSE/streaming endpoints. Detected from the SDK source:
    // Java return type `PhenomlClientHttpResponse<Iterable<...>>`, Python
    // `httpx_client.stream(...)` call. Wire tests for these enqueue a
    // placeholder body (e.g. `{}`) that the SDK never parses as JSON, so
    // the manifest must not surface that placeholder as a real response.
    isStreaming?: boolean;
    // Java-only: Fern request class name from the RawClient method signature
    // (e.g. "CohortRequest"). Drives request-class file discovery in phase
    // 2b. Undefined for endpoints with no body parameter.
    javaRequestClass?: string;
    // Java-only: when the raw client builds the body with explicit
    // `properties.put("jsonKey", request.getX())` calls instead of
    // whole-object `writeValueAsBytes(request)`, this lists those JSON
    // keys in insertion order. When undefined, the body is the whole
    // request object (filter the request class's fields by
    // `javaHeaderJsonKeys` to recover what actually ships).
    javaBodyJsonKeys?: string[];
    // Java-only: JSON keys (from `@JsonProperty`) that the raw client
    // forwards as headers via `.addHeader(...)` rather than including in
    // the body. Used to subtract header fields from the request class
    // catalog when composing the body schema.
    javaHeaderJsonKeys?: string[];
    // Java-only: parameter names (in declaration order) preceding the
    // request body param on the SDK method. These are the positional
    // path/query args the consumer must supply alongside the body.
    javaPositionalParams?: { name: string; type: string }[];
    // Built during a second pass after the file walk; carries the per-
    // endpoint information consumers need to render the SDK call from a
    // user-supplied body. Optional during incremental rollout; when set,
    // copied verbatim onto the corresponding CodeExample.
    renderSchema?: RenderSchema;
}

export interface TestExample {
    httpMethod: string;
    httpPath: string; // Concrete path from mock, e.g., /agent/id
    methodName: string;
    describeBlock: string;
    requestBody: unknown | null;
    responseBody: unknown | null;
    sdkCallArgs: unknown[];
}

export interface CodeExample {
    httpMethod: string;
    httpPath: string;
    request: {
        // Wire JSON body the test example supplied (derived from kwargs for
        // Python). Consumers use this as the deep-merge base for renderCall.
        body: unknown | null;
    };
    response: {
        // For non-streaming endpoints: the wire response JSON the test
        // asserts. For streaming endpoints (`streaming === true`): always
        // null — the wire-test mock body is a placeholder Fern emits that
        // the SDK's streaming path never parses as a real event. The
        // manifest deliberately doesn't surface a first-chunk or
        // accumulated-result example today.
        body: unknown | null;
        // Set on SSE endpoints so docs can render an "event stream" badge
        // instead of treating the (null) body as a missing-example signal.
        streaming?: boolean;
    };
    // Dynamic-render schema. Lets a consumer (e.g. docs playground) regenerate
    // the SDK call for any user-provided body without re-encoding language
    // semantics — see RenderSchema. Optional during phased per-language
    // rollout; populated unconditionally once a language's parser supports it.
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
    // Examples (illustrative, see README):
    //   Java:   "client.tools().analyzeCohort(CohortRequest.builder(){{__body__}}.build())"
    //   Python: "client.tools.analyze_cohort({{__body__}})"
    //   TS:     "client.tools.analyzeCohort({ {{__body__}} })"
    callTemplate: string;
    // Path and query params, ordered to match `callTemplate` placeholders.
    params: ParamField[];
    // Absent for endpoints with no request body (e.g. GETs without query input).
    body?: BodySchema;
}

export interface ParamField {
    // Matches a {{name}} placeholder in callTemplate.
    name: string;
    // Scalar in practice today (Fern emits `string` / `number` / `boolean`
    // for positional path args). Widened to the full SchemaFieldKind union
    // so enum-typed path params surface their wire values via `enumValues`
    // if the SDK type system ever expresses them — gives consumers free
    // dropdowns without a schema-breaking change later.
    kind: SchemaFieldKind;
    // Populated when `kind === "enum"`. Same semantics as SchemaField.enumValues.
    enumValues?: string[];
    // Same semantics as SchemaField.enumConstants — when present, lets the
    // consumer render typed enum constants instead of bare string literals.
    enumConstants?: Record<string, string>;
}

export interface BodySchema {
    // Ordered. For Java staged builders this is the required-fields-first
    // order the builder enforces; for TS/Python it's the declaration order
    // from the request type / raw client signature.
    fields: SchemaField[];
    // Joiner inserted between rendered fields when assembling the body.
    // "" for Java (each field starts with "."), ", " for TS/Python.
    fieldSeparator: string;
    // Language-specific envelope to wrap the joined fields with when this
    // schema is rendered as an inline value (i.e. nested inside a parent
    // field). Contains a `{{__body__}}` placeholder for the joined body.
    // Examples:
    //   Java: "Tag.builder(){{__body__}}.build()"
    //   TS:   "{ {{__body__}} }"
    // Absent on the top-level body — that case is wrapped by the
    // RenderSchema's `callTemplate` instead. Without `wrap`, a nested Java
    // Tag would render as `.name("x").color("red")` and the parent list
    // would emit `Arrays.asList(.name("x").color("red"))`, which is
    // invalid Java.
    wrap?: string;
}

export interface SchemaField {
    // Wire (JSON) key.
    jsonKey: string;
    // Per-field render template containing a `{{value}}` placeholder that
    // the consumer replaces with a language-native literal rendered via
    // renderRules. Examples: `.text({{value}})` (Java), `text={{value}}`
    // (Python), `text: {{value}}` (TS).
    fieldTemplate: string;
    kind: SchemaFieldKind;
    // True when the field has no default and must be present in any
    // generated call (Java staged builders enforce this; TS/Python report
    // it for fidelity).
    required: boolean;
    // Set when `kind === "object"`. Lets the consumer recurse into the
    // nested type without needing language-specific object-rendering
    // logic (each nested level brings its own wrap/separator).
    nested?: BodySchema;
    // Set when `kind === "list"`. Describes a single list item; the
    // consumer applies it once per element.
    items?: SchemaField;
    // Set when `kind === "enum"`. Lists allowed wire values for UI dropdowns.
    enumValues?: string[];
    // Per-wire-value language-specific constant expression for enum fields.
    // Populated when the language requires a typed reference (Java's
    // `AgentRole.ASSISTANT`, TS's `AgentChatRequest.Role.Assistant`); absent
    // for Python where the wire string itself is accepted. The consumer's
    // renderer prefers `enumConstants[value]` over `stringLiteral`-quoting
    // when both are available — without this, a Java setter like
    // `.role(AgentRole role)` would receive `.role("assistant")` which
    // doesn't typecheck.
    enumConstants?: Record<string, string>;
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
    // Each *Literal field contains the literal text for that value kind.
    // String/number/boolean templates contain a `{{value}}` placeholder.
    // For strings, `{{value}}` is replaced with JSON-escaped content
    // (without surrounding quotes); the template supplies the quoting.
    stringLiteral: string;     // e.g. `"{{value}}"`
    numberLiteral: string;     // e.g. `{{value}}`
    trueLiteral: string;       // "true" | "True"
    falseLiteral: string;      // "false" | "False"
    nullLiteral: string;       // "null" | "None"
    // List rendering: `{{items}}` becomes the joined rendered items.
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
    // Language-wide constants for the consumer-side renderer. Same algorithm
    // applies to every SDK language; only these values differ.
    renderRules: RenderRules;
    examples: Record<string, CodeExample>;
}

export interface LanguageParser {
    language: Language;
    parseEndpoints(rootDir: string): EndpointMapping[];
    parseTestExamples(rootDir: string): TestExample[];
}

export interface FernMetadata {
    generatorName: string;
    sdkVersion: string;
    originGitCommit: string;
}
