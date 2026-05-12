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
}

export interface TestExample {
    httpMethod: string;
    httpPath: string; // Concrete path from mock, e.g., /agent/id
    methodName: string;
    describeBlock: string;
    requestBody: unknown | null;
    responseBody: unknown | null;
    sdkCallArgs: unknown[];
    sdkCallSource: string;
}

export interface CodeExample {
    httpMethod: string;
    httpPath: string;
    sdkMethodChain: string[];
    sdkMethodName: string;
    request: {
        body: unknown | null;
        sdkCallArgs: unknown[];
    };
    response: {
        body: unknown | null;
        // Set on SSE endpoints so docs can render an "event stream" badge
        // instead of treating the (null) body as a missing-example signal.
        streaming?: boolean;
    };
    sdkCallSource: string;
}

export interface Manifest {
    metadata: {
        language: string;
        packageName: string;
        sdkVersion: string;
        specCommit: string;
        generatorName: string;
    };
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
