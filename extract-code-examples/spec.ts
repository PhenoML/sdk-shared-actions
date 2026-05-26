import * as fs from "fs";
import type { ResolvedSchema, SpecEndpoint, SpecParam } from "./types";
import { normalizePathParams } from "./utils";

interface OpenApiDocument {
    paths: Record<string, OpenApiPathItem>;
    components?: {
        schemas?: Record<string, OpenApiSchemaNode>;
        parameters?: Record<string, OpenApiParameter>;
    };
}

// A path item carries optional shared `parameters` alongside per-method
// operations. OpenAPI 3 says path-level parameters are inherited by every
// operation on that path; operation-level parameters override by (name, in).
interface OpenApiPathItem {
    parameters?: OpenApiParameterRef[];
    [method: string]: OpenApiOperation | OpenApiParameterRef[] | undefined;
}

interface OpenApiOperation {
    parameters?: OpenApiParameterRef[];
    requestBody?: OpenApiRequestBody;
    responses?: Record<string, OpenApiResponse>;
}

// Parameter as it appears at the call site — either inline or a $ref into
// components.parameters.
type OpenApiParameterRef = OpenApiParameter | { $ref: string };

interface OpenApiParameter {
    name: string;
    in: "path" | "query" | "header" | "cookie";
    required?: boolean;
    schema?: OpenApiSchemaNode;
}

interface OpenApiRequestBody {
    required?: boolean;
    content?: Record<string, OpenApiMediaType>;
}

interface OpenApiResponse {
    content?: Record<string, OpenApiMediaType>;
}

interface OpenApiMediaType {
    schema?: OpenApiSchemaNode;
    example?: unknown;
    // Named examples map. When `example` is absent we pick the first value
    // here as the manifest's example body.
    examples?: Record<string, { summary?: string; value?: unknown }>;
}

// Untyped node — a $ref or any schema fragment as it appears in the document.
type OpenApiSchemaNode = {
    $ref?: string;
    type?: string;
    format?: string;
    required?: string[];
    properties?: Record<string, OpenApiSchemaNode>;
    additionalProperties?: OpenApiSchemaNode | boolean;
    items?: OpenApiSchemaNode;
    enum?: unknown[];
    oneOf?: OpenApiSchemaNode[];
    allOf?: OpenApiSchemaNode[];
    anyOf?: OpenApiSchemaNode[];
};

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch"]);

export function loadSpec(specPath: string): SpecEndpoint[] {
    if (!fs.existsSync(specPath)) {
        throw new Error(`OpenAPI spec not found at ${specPath}`);
    }
    const doc = JSON.parse(fs.readFileSync(specPath, "utf-8")) as OpenApiDocument;
    const schemas = doc.components?.schemas ?? {};
    const parameters = doc.components?.parameters ?? {};
    // One shared cache across the whole spec — the same `Tag`/`Patient`/etc.
    // schema is $ref'd from many endpoints, and resolving it more than once
    // is the biggest hot spot for large specs.
    const resolveCache = new Map<string, ResolvedSchema>();
    const endpoints: SpecEndpoint[] = [];

    for (const [rawPath, pathItem] of Object.entries(doc.paths ?? {})) {
        const httpPath = normalizePathParams(rawPath);
        const pathLevelParams = pathItem.parameters ?? [];
        for (const [methodLower, op] of Object.entries(pathItem)) {
            if (!HTTP_METHODS.has(methodLower)) continue;
            const operation = op as OpenApiOperation;
            const mergedParams = mergeParameters(pathLevelParams, operation.parameters ?? [], parameters);
            endpoints.push(buildSpecEndpoint(
                methodLower.toUpperCase(),
                httpPath,
                { ...operation, parameters: mergedParams },
                schemas,
                parameters,
                resolveCache,
            ));
        }
    }
    return endpoints;
}

// Combine path-level parameters (inherited by every operation on the path)
// with operation-level parameters. Per OpenAPI 3, the operation entry wins
// when both share (name, in). Path-level entries come first so URL-order
// declarations stay aligned when operations only add new params.
function mergeParameters(
    pathLevel: OpenApiParameterRef[],
    opLevel: OpenApiParameterRef[],
    registry: Record<string, OpenApiParameter>,
): OpenApiParameterRef[] {
    if (pathLevel.length === 0) return opLevel;
    const opKeys = new Set<string>();
    for (const ref of opLevel) {
        const p = resolveParameter(ref, registry);
        if (p) opKeys.add(`${p.in}:${p.name}`);
    }
    const inherited = pathLevel.filter((ref) => {
        const p = resolveParameter(ref, registry);
        return !p || !opKeys.has(`${p.in}:${p.name}`);
    });
    return [...inherited, ...opLevel];
}

function buildSpecEndpoint(
    httpMethod: string,
    httpPath: string,
    op: OpenApiOperation,
    schemas: Record<string, OpenApiSchemaNode>,
    parameters: Record<string, OpenApiParameter>,
    resolveCache: Map<string, ResolvedSchema>,
): SpecEndpoint {
    const resolve = (node: OpenApiSchemaNode) => resolveSchema(node, schemas, new Set(), resolveCache);

    const pathParams: SpecParam[] = [];
    const queryParams: SpecParam[] = [];
    for (const ref of op.parameters ?? []) {
        const p = resolveParameter(ref, parameters);
        if (!p) continue;
        const entry: SpecParam = { name: p.name };
        if (p.required) entry.required = true;
        if (p.schema) entry.schema = resolve(p.schema);
        if (p.in === "path") pathParams.push(entry);
        else if (p.in === "query") queryParams.push(entry);
    }

    const jsonReq = pickJsonContent(op.requestBody?.content);
    const requestSchema = jsonReq?.schema ? resolve(jsonReq.schema) : undefined;
    const requestExample = pickExampleValue(jsonReq);

    const { responseExample, isStreaming } = pickResponseExample(op);

    const ep: SpecEndpoint = {
        httpMethod,
        httpPath,
        pathParams,
        queryParams,
        isStreaming,
    };
    if (requestSchema) ep.requestSchema = requestSchema;
    if (requestExample !== undefined) ep.requestExample = requestExample;
    if (responseExample !== undefined) ep.responseExample = responseExample;
    return ep;
}

function resolveParameter(
    ref: OpenApiParameterRef,
    parameters: Record<string, OpenApiParameter>,
): OpenApiParameter | undefined {
    if ("$ref" in ref) {
        const m = ref.$ref.match(/^#\/components\/parameters\/(.+)$/);
        return m ? parameters[m[1]] : undefined;
    }
    return ref;
}

// Picks the first JSON-flavored media type — `application/json` is canonical,
// but Fern also emits `application/fhir+json` for FHIR passthrough endpoints
// and `application/json+patch` for JSON-Patch bodies. Matches by suffix so we
// don't have to enumerate every variant.
function pickJsonContent(
    content: Record<string, OpenApiMediaType> | undefined,
): OpenApiMediaType | undefined {
    if (!content) return undefined;
    if (content["application/json"]) return content["application/json"];
    for (const [ct, media] of Object.entries(content)) {
        if (ct.includes("json")) return media;
    }
    return undefined;
}

// Single `example` wins. When absent, fall back to the first entry in the
// `examples` map. Returns undefined when neither carries a value.
function pickExampleValue(media: OpenApiMediaType | undefined): unknown | undefined {
    if (!media) return undefined;
    if (media.example !== undefined) return media.example;
    if (media.examples) {
        for (const e of Object.values(media.examples)) {
            if (e?.value !== undefined) return e.value;
        }
    }
    return undefined;
}

// Walks the 2xx responses. If any 2xx declares `text/event-stream`, the
// endpoint is streaming — docs render an "event stream" badge and the body
// is suppressed (the placeholder SSE frame would mislead). SSE detection
// takes precedence: a response that lists both `text/event-stream` AND
// `application/json` is still a streaming endpoint, and the JSON entry is
// typically a placeholder. Otherwise the first 2xx with a JSON-flavored
// content type wins (curated bodies live there).
function pickResponseExample(op: OpenApiOperation): { responseExample?: unknown; isStreaming: boolean } {
    let isStreaming = false;
    let jsonExample: unknown | undefined;
    for (const [code, resp] of Object.entries(op.responses ?? {})) {
        if (!/^2/.test(code)) continue;
        const content = resp.content ?? {};
        if ("text/event-stream" in content) isStreaming = true;
        // Once we know it's streaming, the JSON body will be discarded — stop
        // resolving it. Still need to keep walking responses to catch SSE on
        // a later 2xx code.
        if (!isStreaming && jsonExample === undefined) {
            const jsonMedia = pickJsonContent(content);
            if (jsonMedia) jsonExample = pickExampleValue(jsonMedia);
        }
    }
    if (isStreaming) return { isStreaming: true };
    return jsonExample !== undefined
        ? { isStreaming: false, responseExample: jsonExample }
        : { isStreaming: false };
}

// Resolves $refs and inlines them. Cycle-safe via a visited set carrying the
// ref names traversed on the current path — a self-referential schema gets
// its inner $ref left as a bare `{$refName}` marker so consumers can detect
// recursion without us blowing the stack. The `cache` memoizes fully-resolved
// schemas across endpoints (the same `$ref` is reached from many places);
// only safe to read/write when `visited` is empty, so partial cycle-broken
// shapes don't poison the cache for later non-cyclic lookups.
function resolveSchema(
    node: OpenApiSchemaNode,
    schemas: Record<string, OpenApiSchemaNode>,
    visited: Set<string>,
    cache: Map<string, ResolvedSchema>,
): ResolvedSchema {
    if (node.$ref) {
        const name = refName(node.$ref);
        if (!name || !(name in schemas)) return { $refName: name ?? undefined };
        if (visited.has(name)) return { $refName: name };
        if (visited.size === 0) {
            const hit = cache.get(name);
            if (hit) return hit;
        }
        const next = new Set(visited);
        next.add(name);
        const resolved = resolveSchema(schemas[name], schemas, next, cache);
        resolved.$refName = name;
        if (visited.size === 0) cache.set(name, resolved);
        return resolved;
    }

    const out: ResolvedSchema = {};
    if (node.type === "string" || node.type === "number" || node.type === "integer" ||
        node.type === "boolean" || node.type === "array" || node.type === "object") {
        out.type = node.type;
    }
    if (node.format) out.format = node.format;
    if (node.required) out.required = [...node.required];
    if (node.enum) out.enum = [...node.enum];

    if (node.properties) {
        out.properties = {};
        for (const [k, v] of Object.entries(node.properties)) {
            out.properties[k] = resolveSchema(v, schemas, visited, cache);
        }
    }
    if (node.items) out.items = resolveSchema(node.items, schemas, visited, cache);
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
        out.additionalProperties = resolveSchema(node.additionalProperties, schemas, visited, cache);
    } else if (typeof node.additionalProperties === "boolean") {
        out.additionalProperties = node.additionalProperties;
    }
    if (node.oneOf) out.oneOf = node.oneOf.map((n) => resolveSchema(n, schemas, visited, cache));
    if (node.anyOf) out.anyOf = node.anyOf.map((n) => resolveSchema(n, schemas, visited, cache));
    if (node.allOf) {
        // Flatten allOf into the result: merge required + properties from each
        // member. Fern uses allOf as inheritance, so the consumer effectively
        // sees a single object schema with the union of fields.
        const merged: ResolvedSchema = { ...out };
        const properties: Record<string, ResolvedSchema> = { ...(out.properties ?? {}) };
        const required: string[] = [...(out.required ?? [])];
        for (const member of node.allOf) {
            const r = resolveSchema(member, schemas, visited, cache);
            if (r.type && !merged.type) merged.type = r.type;
            if (r.properties) Object.assign(properties, r.properties);
            if (r.required) for (const k of r.required) if (!required.includes(k)) required.push(k);
        }
        if (Object.keys(properties).length > 0) merged.properties = properties;
        if (required.length > 0) merged.required = required;
        return merged;
    }
    return out;
}

function refName(ref: string): string | null {
    const m = ref.match(/^#\/components\/schemas\/(.+)$/);
    return m ? m[1] : null;
}
