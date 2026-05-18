import type {
    CodeExample,
    EndpointMapping,
    FernMetadata,
    Language,
    Manifest,
    RenderRules,
    TestExample,
} from "./types";
import { pathMatchesTemplate } from "./utils";

// Per-language constants consumed by the (language-agnostic) renderer that
// runs in downstream tools. Adding a new SDK language means adding an entry
// here plus a parser that emits RenderSchema on each example.
const RENDER_RULES_BY_LANGUAGE: Record<Language, RenderRules> = {
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
        // Fern's Java codegen emits `Arrays.asList(...)` for list literals,
        // so the consumer matches that convention rather than `List.of(...)`.
        listLiteral: `Arrays.asList({{items}})`,
        listSeparator: ", ",
    },
};

export function findTemplateMatch(
    httpMethod: string,
    concretePath: string,
    endpointMap: Map<string, EndpointMapping>,
): EndpointMapping | undefined {
    for (const [, endpoint] of endpointMap) {
        if (endpoint.httpMethod !== httpMethod) continue;
        if (pathMatchesTemplate(endpoint.httpPath, concretePath)) return endpoint;
    }
    return undefined;
}

// When `endpoint.bodyPassthroughKwarg` is set, the entire HTTP body is that
// kwarg's value (no field wrapping) — used by raw clients that pass the
// argument directly as `json=<kwarg>` or `json=wrapper(object_=<kwarg>, ...)`.
// If the kwarg isn't present in the call args, the `json=<ident>` was likely
// an intermediate variable built earlier in the method body rather than a
// real SDK parameter, so fall through to the kwarg-based heuristic below
// instead of dropping the body. Otherwise when `endpoint.bodyParamMap` is
// set (extracted from the raw client's `json={...}` dict), use it both to
// exclude header/query/path kwargs AND to translate the kwarg name back to
// the JSON field name (Fern sometimes aliases, e.g., `"someField": some_field`).
// Literal-valued fields from the dict (e.g., `"resourceType": "Bundle"`) are
// merged in via `endpoint.bodyLiterals`. Otherwise fall back to "everything
// except path params" with the kwarg name used as the body key — imperfect
// (header/query kwargs leak; aliased fields emit the wrong key) but the
// best we can do without raw-client info.
export function deriveBodyFromKwargs(
    endpoint: EndpointMapping,
    sdkCallArgs: unknown[],
): unknown | null {
    if (!["POST", "PUT", "PATCH"].includes(endpoint.httpMethod)) return null;
    if (endpoint.bodyPassthroughKwarg !== undefined) {
        const target = endpoint.bodyPassthroughKwarg;
        for (const arg of sdkCallArgs) {
            if (!arg || typeof arg !== "object" || !("name" in arg) || !("value" in arg)) continue;
            const { name, value } = arg as { name: unknown; value: unknown };
            if (name === target) return value;
        }
        // Fall through: the kwarg isn't in the call args, so treat
        // `json=<ident>` as a non-passthrough builder variable and let
        // the kwarg-based heuristic assemble the body.
    }
    const resolveKey = bodyKeyResolver(endpoint);
    const body: Record<string, unknown> = { ...(endpoint.bodyLiterals ?? {}) };
    let count = Object.keys(body).length;
    for (const arg of sdkCallArgs) {
        if (!arg || typeof arg !== "object" || !("name" in arg) || !("value" in arg)) continue;
        const { name, value } = arg as { name: unknown; value: unknown };
        if (typeof name !== "string") continue;
        const key = resolveKey(name);
        if (key === null) continue;
        body[key] = value;
        count++;
    }
    return count > 0 ? body : null;
}

// Counts how many of {body, responseBody} carry data. Used to decide
// which of two examples for the same endpoint should land in the manifest
// — higher score wins, ties keep the first. The Python authtoken fixture
// relies on this to pick the kwarg-bearing test over the body-less one.
function codeExampleRichness(ex: CodeExample): number {
    let score = 0;
    if (ex.request.body !== null) score++;
    if (ex.response.body !== null) score++;
    return score;
}

// Returns a function mapping an SDK kwarg name to its body field name,
// or null if the kwarg shouldn't be in the body at all.
function bodyKeyResolver(endpoint: EndpointMapping): (name: string) => string | null {
    if (endpoint.bodyParamMap !== undefined) {
        const map = endpoint.bodyParamMap;
        return (name) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null);
    }
    const pathParams = new Set<string>();
    for (const m of endpoint.httpPath.matchAll(/\{(\w+)\}/g)) pathParams.add(m[1]);
    return (name) => (pathParams.has(name) ? null : name);
}

export function buildManifest(
    allEndpoints: EndpointMapping[],
    allExamples: TestExample[],
    language: Language,
    packageName: string,
    metadata: FernMetadata,
): Manifest {
    const endpointMap = new Map<string, EndpointMapping>();
    // Secondary index for chain-based matching (Java tests don't have httpPath).
    // Key: lowercased concat of chain-prefix segments + "." + methodName. Two
    // different chains can collapse to the same key (e.g. ["agent","prompts"]
    // and ["agentp","rompts"] both → "agentprompts"); when that happens we
    // drop the ambiguous entry so lookup misses loudly rather than silently
    // returning the wrong endpoint.
    const chainIndex = new Map<string, EndpointMapping>();
    const chainCollisions = new Set<string>();
    for (const ep of allEndpoints) {
        endpointMap.set(`${ep.httpMethod} ${ep.httpPath}`, ep);
        const prefix = ep.methodChain.slice(0, -1).join("").toLowerCase();
        const key = `${prefix}.${ep.methodName.toLowerCase()}`;
        const existing = chainIndex.get(key);
        if (existing && existing !== ep) {
            chainCollisions.add(key);
        }
        chainIndex.set(key, ep);
    }
    for (const key of chainCollisions) {
        console.error(`  WARNING: chain-index collision for "${key}"; dropping ambiguous entry`);
        chainIndex.delete(key);
    }

    const manifest: Manifest = {
        metadata: {
            language,
            packageName,
            sdkVersion: metadata.sdkVersion,
            specCommit: metadata.originGitCommit || "unknown",
            generatorName: metadata.generatorName,
        },
        renderRules: RENDER_RULES_BY_LANGUAGE[language],
        examples: {},
    };

    let matched = 0;
    let unmatched = 0;

    for (const example of allExamples) {
        const exactKey = `${example.httpMethod} ${example.httpPath}`;
        let endpoint = endpointMap.get(exactKey) ?? findTemplateMatch(example.httpMethod, example.httpPath, endpointMap);

        // Fallback: match by method chain (for Java tests that don't have httpPath)
        if (!endpoint && !example.httpPath && example.describeBlock) {
            const filePrefix = example.describeBlock.replace(/WireTest\.java$/, "").toLowerCase();
            const chainKey = `${filePrefix}.${example.methodName.toLowerCase()}`;
            endpoint = chainIndex.get(chainKey);
        }

        if (endpoint) {
            const key = `${endpoint.httpMethod} ${endpoint.httpPath}`;
            const body = example.requestBody ?? deriveBodyFromKwargs(endpoint, example.sdkCallArgs);
            // SSE: drop the mock placeholder body — see EndpointMapping.isStreaming.
            const response: CodeExample["response"] = endpoint.isStreaming
                ? { body: null, streaming: true }
                : { body: example.responseBody };
            const candidate: CodeExample = {
                httpMethod: endpoint.httpMethod,
                httpPath: endpoint.httpPath,
                request: { body },
                response,
            };
            if (endpoint.renderSchema) candidate.render = endpoint.renderSchema;
            // Multiple wire tests can target the same endpoint (success +
            // variants, or — like the python fixture — a test that omits
            // kwargs to exercise an unrelated parser path). Prefer the
            // richer entry so an emptier later test can't erase a body or
            // call-args populated by an earlier one.
            const existing = manifest.examples[key];
            if (!existing || codeExampleRichness(candidate) > codeExampleRichness(existing)) {
                manifest.examples[key] = candidate;
            }
            matched++;
        } else {
            console.error(`  WARNING: No endpoint match for test: ${exactKey}`);
            unmatched++;
        }
    }

    const coveredKeys = new Set(Object.keys(manifest.examples));
    const uncovered = allEndpoints.filter((ep) => !coveredKeys.has(`${ep.httpMethod} ${ep.httpPath}`));
    if (uncovered.length > 0) {
        console.error(`\n  Endpoints without test coverage:`);
        for (const ep of uncovered) {
            console.error(`    ${ep.httpMethod} ${ep.httpPath} (${ep.methodChain.join(".")})`);
        }
    }

    console.error(`\n  Matched: ${matched}, Unmatched: ${unmatched}`);
    console.error(`  Coverage: ${matched}/${allEndpoints.length} endpoints have examples`);
    return manifest;
}
