import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
    buildManifest,
    buildRenderSchema,
    camelToSnake,
    createJavaParser,
    createPythonParser,
    createTypeScriptParser,
    loadSpec,
    normalizePath,
    normalizePathParams,
    pascalCase,
    resolveSpecPath,
    snakeToCamel,
} from "../index";
import {
    javaBuildAccessorMap,
    javaDeriveMethodChain,
    javaExtractEndpoints,
    javaExtractRequestClassName,
} from "../parsers/java";
import { pyDeriveMethodChain, pyExtractEndpoints } from "../parsers/python";
import { tsExtractEndpoints } from "../parsers/typescript";

const FIXTURES = path.join(import.meta.dir, "fixtures");

const originalConsoleError = console.error;
beforeAll(() => { console.error = () => {}; });
afterAll(() => { console.error = originalConsoleError; });

// ============================================================
// Pure helpers
// ============================================================

describe("normalizePath", () => {
    test("ensures a leading slash", () => {
        expect(normalizePath("agent/create")).toBe("/agent/create");
    });
    test("strips a trailing slash", () => {
        expect(normalizePath("/agent/")).toBe("/agent");
    });
    test("preserves root slash", () => {
        expect(normalizePath("/")).toBe("/");
    });
});

describe("normalizePathParams", () => {
    test("camelCase → snake_case", () => {
        expect(normalizePathParams("/agent/{agentId}")).toBe("/agent/{agent_id}");
    });
    test("leaves snake_case alone", () => {
        expect(normalizePathParams("/x/{foo_bar}")).toBe("/x/{foo_bar}");
    });
});

describe("case conversion helpers", () => {
    test("camelToSnake handles all-caps run", () => {
        expect(camelToSnake("codeID")).toBe("code_id");
    });
    test("snakeToCamel basic", () => {
        expect(snakeToCamel("client_secret")).toBe("clientSecret");
    });
    test("pascalCase converts snake to Pascal", () => {
        expect(pascalCase("client_credentials")).toBe("ClientCredentials");
    });
    test("pascalCase handles kebab too", () => {
        expect(pascalCase("client-secret")).toBe("ClientSecret");
    });
});

describe("resolveSpecPath override handling", () => {
    test("relative override resolves against rootDir, not process cwd", () => {
        const root = path.join(FIXTURES, "python");
        const resolved = resolveSpecPath(root, "python", "src/phenoml/openapi/openapi.json");
        expect(resolved).toBe(path.join(root, "src/phenoml/openapi/openapi.json"));
    });

    test("absolute override is taken verbatim", () => {
        const absolute = path.join(FIXTURES, "openapi-shared.json");
        expect(resolveSpecPath("/some/unrelated/root", "python", absolute)).toBe(absolute);
    });

    test("no override falls back to the per-language default under rootDir", () => {
        const root = path.join(FIXTURES, "python");
        const resolved = resolveSpecPath(root, "python");
        expect(resolved).toBe(path.join(root, "src/phenoml/openapi/openapi.json"));
    });
});

// ============================================================
// Spec loader
// ============================================================

describe("loadSpec", () => {
    const specPath = path.join(FIXTURES, "openapi-shared.json");

    test("loads endpoints from the fixture spec", () => {
        const endpoints = loadSpec(specPath);
        expect(endpoints.length).toBe(11);
        const keys = endpoints.map((e) => `${e.httpMethod} ${e.httpPath}`).sort();
        expect(keys).toEqual([
            "DELETE /agent/{id}",
            "GET /agent/list",
            "GET /agent/{id}",
            "GET /agent/{id}/comments/{comment_id}",
            "PATCH /agent/{id}/comments/{comment_id}",
            "PATCH /agent/{id}/patch-with-filter",
            "POST /agent/create",
            "POST /agent/dual-content",
            "POST /agent/stream",
            "POST /agent/union",
            // URL placeholder normalizes to `{code_id}` via normalizePathParams
            // even though the OpenAPI parameter name is `codeID` — the spec
            // entry keeps the raw OpenAPI form (`codeID`) so language-agnostic
            // consumers see what the spec declares.
            "POST /construe/codes/{code_id}",
        ]);
    });

    test("path param name is preserved verbatim from the OpenAPI spec (the URL template normalizes separately)", () => {
        const endpoints = loadSpec(specPath);
        const ep = endpoints.find((e) => e.httpPath === "/construe/codes/{code_id}");
        expect(ep?.pathParams.map((p) => p.name)).toEqual(["codeID"]);
    });

    test("path-level parameters are inherited by every operation on the path", () => {
        const endpoints = loadSpec(specPath);
        // GET has no parameters of its own — should inherit all three path-level entries.
        const get = endpoints.find((e) => e.httpMethod === "GET" && e.httpPath === "/agent/{id}/comments/{comment_id}");
        expect(get?.pathParams.map((p) => p.name)).toEqual(["id", "comment_id"]);
        expect(get?.queryParams).toEqual([{ name: "verbose", schema: { type: "boolean" } }]);
    });

    test("operation-level parameters override path-level entries by (name, in)", () => {
        const endpoints = loadSpec(specPath);
        // PATCH overrides `verbose` (boolean at path level → string at op level).
        const patch = endpoints.find((e) => e.httpMethod === "PATCH" && e.httpPath === "/agent/{id}/comments/{comment_id}");
        expect(patch?.pathParams.map((p) => p.name)).toEqual(["id", "comment_id"]);
        expect(patch?.queryParams).toEqual([{ name: "verbose", schema: { type: "string" } }]);
    });

    test("resolves $ref parameters", () => {
        const endpoints = loadSpec(specPath);
        const getById = endpoints.find((e) => e.httpMethod === "GET" && e.httpPath === "/agent/{id}");
        expect(getById?.pathParams).toEqual([
            { name: "id", required: true, schema: { type: "string" } },
        ]);
    });

    test("captures query parameters separately", () => {
        const endpoints = loadSpec(specPath);
        const list = endpoints.find((e) => e.httpMethod === "GET" && e.httpPath === "/agent/list");
        expect(list?.queryParams).toEqual([
            { name: "tags", schema: { type: "string" } },
        ]);
    });

    test("uses `example` when present, falls back to first `examples` entry", () => {
        const endpoints = loadSpec(specPath);
        const create = endpoints.find((e) => e.httpMethod === "POST" && e.httpPath === "/agent/create");
        expect(create?.requestExample).toEqual({
            name: "Medical Assistant",
            description: "Helps with FHIR coding",
            role: "assistant",
        });
        const list = endpoints.find((e) => e.httpMethod === "GET" && e.httpPath === "/agent/list");
        expect(list?.responseExample).toEqual({ agents: [{ id: "agent_123" }] });
    });

    test("flags streaming endpoints and suppresses response example", () => {
        const endpoints = loadSpec(specPath);
        const stream = endpoints.find((e) => e.httpMethod === "POST" && e.httpPath === "/agent/stream");
        expect(stream?.isStreaming).toBe(true);
        expect(stream?.responseExample).toBeUndefined();
    });

    test("text/event-stream wins over application/json when both are declared on the same response", () => {
        // A 2xx that lists both content types is still a streaming endpoint —
        // the JSON entry is typically a placeholder.
        const endpoints = loadSpec(specPath);
        const dual = endpoints.find((e) => e.httpMethod === "POST" && e.httpPath === "/agent/dual-content");
        expect(dual?.isStreaming).toBe(true);
        expect(dual?.responseExample).toBeUndefined();
    });

    test("resolves $ref schemas into inline shapes", () => {
        const endpoints = loadSpec(specPath);
        const create = endpoints.find((e) => e.httpMethod === "POST" && e.httpPath === "/agent/create");
        expect(create?.requestSchema?.type).toBe("object");
        expect(create?.requestSchema?.required).toEqual(["name", "role"]);
        expect(create?.requestSchema?.properties?.role.enum).toEqual(["assistant", "user", "system"]);
        expect(create?.requestSchema?.properties?.role.$refName).toBe("agent_AgentRole");
    });
});

// ============================================================
// Parsers
// ============================================================

describe("pyExtractEndpoints", () => {
    const file = path.join(FIXTURES, "python/src/phenoml/agent/raw_client.py");
    const pkgRoot = path.join(FIXTURES, "python/src/phenoml");
    const findEndpoint = (method: string, p: string) =>
        pyExtractEndpoints(file, pkgRoot).find((e) => e.httpMethod === method && e.httpPath === p);

    test("extracts all sync-class endpoints, skipping async twin", () => {
        const endpoints = pyExtractEndpoints(file, pkgRoot);
        const keys = endpoints.map((e) => `${e.httpMethod} ${e.httpPath}`).sort();
        expect(keys).toEqual([
            "DELETE /agent/{id}",
            "GET /agent/list",
            "GET /agent/{id}",
            "PATCH /agent/{id}/patch-with-filter",
            "POST /agent/create",
            "POST /agent/stream",
            "POST /construe/codes/{code_id}",
        ]);
    });

    test("captures path-param SDK identifiers in URL order", () => {
        // `f"agent/{jsonable_encoder(id)}/patch-with-filter"` → ["id"]
        expect(findEndpoint("PATCH", "/agent/{id}/patch-with-filter")?.pathParamNames).toEqual(["id"]);
        // Single-segment path params still report.
        expect(findEndpoint("GET", "/agent/{id}")?.pathParamNames).toEqual(["id"]);
        // Multi-segment paths preserve order.
        expect(findEndpoint("POST", "/construe/codes/{code_id}")?.pathParamNames).toEqual(["code_id"]);
    });

    test("captures wire→identifier map from `json={...}` dict literal", () => {
        // post_code's signature uses snake_case Python identifiers for camelCase
        // OpenAPI keys — the parser reads the mapping straight from the dict.
        expect(findEndpoint("POST", "/construe/codes/{code_id}")?.bodyKwargByJsonKey).toEqual({
            resourceType: "resource_type",
            fhir_path: "fhir_path",
        });
        // Already-aligned identifiers come through unchanged.
        expect(findEndpoint("POST", "/agent/create")?.bodyKwargByJsonKey).toEqual({
            name: "name",
            description: "description",
            role: "role",
        });
    });

    test("captures passthrough body kwarg from `json=jsonable_encoder(<ident>)`", () => {
        const patch = findEndpoint("PATCH", "/agent/{id}/patch-with-filter");
        expect(patch?.bodyKwargForPassthrough).toBe("request");
        // No corresponding dict map for passthrough bodies.
        expect(patch?.bodyKwargByJsonKey).toBeUndefined();
    });

    test("captures query kwargs from `params={...}`", () => {
        // list() declares `params={"tags": tags}` — the wire key matches the
        // Python kwarg here, but the extraction path is the same as bodies.
        expect(findEndpoint("GET", "/agent/list")?.bodyKwargByJsonKey).toEqual({ tags: "tags" });
    });

    test("endpoints with no request body / query params omit the kwarg map", () => {
        const get = findEndpoint("GET", "/agent/{id}");
        expect(get?.bodyKwargByJsonKey).toBeUndefined();
        expect(get?.bodyKwargForPassthrough).toBeUndefined();
    });

    test("derives method chain from file path", () => {
        expect(pyDeriveMethodChain("agent/raw_client.py")).toEqual(["agent"]);
        expect(pyDeriveMethodChain("tools/resources/mcp_server/raw_client.py"))
            .toEqual(["tools", "mcp_server"]);
    });
});

describe("tsExtractEndpoints", () => {
    test("extracts all `__methodName` impls", () => {
        const file = path.join(FIXTURES, "typescript/src/api/resources/agent/client/Client.ts");
        const endpoints = tsExtractEndpoints(file);
        const keys = endpoints.map((e) => `${e.httpMethod} ${e.httpPath}`).sort();
        expect(keys).toEqual([
            "DELETE /agent/{id}",
            "GET /agent/list",
            "GET /agent/{id}",
            "GET /agent/{id}/legacy",
            "GET /agent/{id}/subst",
            "POST /agent/create",
            "POST /agent/legacy",
            "POST /agent/stream",
        ]);
    });

    test("rebuilds template-literal paths with bare `{name}`", () => {
        const file = path.join(FIXTURES, "typescript/src/api/resources/agent/client/Client.ts");
        const endpoints = tsExtractEndpoints(file);
        const get = endpoints.find((e) => e.httpMethod === "GET" && e.httpPath === "/agent/{id}");
        expect(get?.methodChain).toEqual(["agent", "get"]);
    });

    test("legacy URL shapes (direct string, absolute template literal, ${baseUrl}-prefix template) all parse", () => {
        const file = path.join(FIXTURES, "typescript/src/api/resources/agent/client/Client.ts");
        const endpoints = tsExtractEndpoints(file);
        // Direct string literal with embedded host.
        const legacyString = endpoints.find((e) => e.methodName === "legacyString");
        expect(legacyString?.httpPath).toBe("/agent/legacy");
        // Direct template literal with absolute host and bare-identifier substitution.
        const legacyTemplate = endpoints.find((e) => e.methodName === "legacyTemplate");
        expect(legacyTemplate?.httpPath).toBe("/agent/{id}/legacy");
        // ${baseUrl} substitution as URL prefix.
        const baseUrlSubst = endpoints.find((e) => e.methodName === "baseUrlSubst");
        expect(baseUrlSubst?.httpPath).toBe("/agent/{id}/subst");
    });
});

describe("javaExtractEndpoints", () => {
    test("extracts all endpoints across multi-line signatures and nested generics", () => {
        const file = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources/agent/RawAgentClient.java");
        const resourcesDir = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources");
        const endpoints = javaExtractEndpoints(file, resourcesDir);
        const keys = endpoints.map((e) => `${e.httpMethod} ${e.httpPath}`).sort();
        expect(keys).toEqual([
            "DELETE /agent/{id}",
            "GET /agent/list",
            "GET /agent/{id}",
            "PATCH /agent/{id}",
            "PATCH /agent/{id}/tag/{tag_id}",
            "POST /agent/create",
            "POST /agent/fetch",
            "POST /agent/stream",
            "PUT /agent/by-uuid/{id}",
        ]);
    });

    test("captures request class name from method signature", () => {
        const file = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources/agent/RawAgentClient.java");
        const resourcesDir = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources");
        const endpoints = javaExtractEndpoints(file, resourcesDir);
        const create = endpoints.find((e) => e.httpMethod === "POST" && e.httpPath === "/agent/create");
        expect(create?.requestClassName).toBe("AgentCreateRequest");
        // No body → no request class
        const get = endpoints.find((e) => e.httpMethod === "GET" && e.httpPath === "/agent/{id}");
        expect(get?.requestClassName).toBeUndefined();
    });

    test("List<...> passthrough body yields no request class (not 'ListXxx')", () => {
        const file = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources/agent/RawAgentClient.java");
        const resourcesDir = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources");
        const endpoints = javaExtractEndpoints(file, resourcesDir);
        const patch = endpoints.find((e) => e.httpMethod === "PATCH" && e.httpPath === "/agent/{id}");
        expect(patch?.requestClassName).toBeUndefined();
    });

    test("wrapper-typed path param doesn't shadow the trailing body class", () => {
        const file = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources/agent/RawAgentClient.java");
        const resourcesDir = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources");
        const endpoints = javaExtractEndpoints(file, resourcesDir);
        const update = endpoints.find((e) => e.httpMethod === "PUT" && e.httpPath === "/agent/by-uuid/{id}");
        expect(update?.requestClassName).toBe("AgentUpdateRequest");
    });

    test("Optional<XxxRequest> body unwraps to XxxRequest", () => {
        const file = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources/agent/RawAgentClient.java");
        const resourcesDir = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources");
        const endpoints = javaExtractEndpoints(file, resourcesDir);
        const fetch = endpoints.find((e) => e.httpMethod === "POST" && e.httpPath === "/agent/fetch");
        expect(fetch?.requestClassName).toBe("FetchRequest");
    });

    test("extracts a method whose signature spans 3+ lines (one param per line)", () => {
        const file = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources/agent/RawAgentClient.java");
        const resourcesDir = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources");
        const endpoints = javaExtractEndpoints(file, resourcesDir);
        const multi = endpoints.find((e) => e.methodName === "multiLine");
        expect(multi).toBeDefined();
        expect(multi?.httpMethod).toBe("PATCH");
        expect(multi?.httpPath).toBe("/agent/{id}/tag/{tag_id}");
        expect(multi?.requestClassName).toBe("AgentUpdateRequest");
    });

    test("stops path collection at first .build() — streaming endpoints have two newBuilder() calls", () => {
        const file = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources/agent/RawAgentClient.java");
        const resourcesDir = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources");
        const endpoints = javaExtractEndpoints(file, resourcesDir);
        const stream = endpoints.find((e) => e.httpMethod === "POST" && e.httpPath === "/agent/stream");
        expect(stream).toBeDefined();
    });

    test("derives method chain via resources path with no accessor map", () => {
        expect(javaDeriveMethodChain(
            "/x/resources/agent/RawAgentClient.java",
            "/x/resources",
        )).toEqual(["agent"]);
    });
});

describe("javaExtractRequestClassName unit cases", () => {
    test("body class (no path/options trailing)", () => {
        expect(javaExtractRequestClassName("AgentCreateRequest request"))
            .toBe("AgentCreateRequest");
    });
    test("trailing RequestOptions is ignored", () => {
        expect(javaExtractRequestClassName("AgentCreateRequest request, RequestOptions requestOptions"))
            .toBe("AgentCreateRequest");
    });
    test("path-only method (String id)", () => {
        expect(javaExtractRequestClassName("String id, RequestOptions requestOptions")).toBeUndefined();
    });
    test("wrapper path types are also recognized as scalars", () => {
        expect(javaExtractRequestClassName("UUID id, RequestOptions requestOptions")).toBeUndefined();
        expect(javaExtractRequestClassName("Integer count")).toBeUndefined();
        expect(javaExtractRequestClassName("LocalDateTime when, RequestOptions requestOptions")).toBeUndefined();
    });
    test("mixed path + body picks the body class, not the path scalar", () => {
        expect(javaExtractRequestClassName("UUID id, AgentUpdateRequest request, RequestOptions requestOptions"))
            .toBe("AgentUpdateRequest");
        expect(javaExtractRequestClassName("String id, AgentUpdateRequest request"))
            .toBe("AgentUpdateRequest");
    });
    test("List<...> body is a passthrough — no builder class", () => {
        expect(javaExtractRequestClassName("String id, List<JsonPatchOperation> request")).toBeUndefined();
        expect(javaExtractRequestClassName("String id, List<JsonPatchOperation> request, RequestOptions requestOptions"))
            .toBeUndefined();
    });
    test("Optional<XxxRequest> body unwraps", () => {
        expect(javaExtractRequestClassName("Optional<FetchRequest> request"))
            .toBe("FetchRequest");
        expect(javaExtractRequestClassName("Optional<FetchRequest> request, RequestOptions requestOptions"))
            .toBe("FetchRequest");
    });
    test("nested-generic param type doesn't trip the top-level comma split", () => {
        // Map<String, Object> contains a comma at depth 1 — splitter must
        // keep it in one piece.
        expect(javaExtractRequestClassName("String id, Map<String, Object> request"))
            .toBeUndefined(); // Map<...> → collection-typed passthrough
    });
    test("empty param list (no-arg method)", () => {
        expect(javaExtractRequestClassName("")).toBeUndefined();
    });
});

// ============================================================
// Render rules
// ============================================================

describe("buildRenderSchema", () => {
    const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
    const findSpec = (m: string, p: string) => spec.find((s) => s.httpMethod === m && s.httpPath === p)!;

    test("Python: kwarg-style field templates and call template", () => {
        const create = findSpec("POST", "/agent/create");
        const render = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
        }, "python");
        expect(render.callTemplate).toBe("client.agent.create({{__body__}})");
        expect(render.body?.fieldSeparator).toBe(", ");
        expect(render.body?.fields[0]).toEqual({
            jsonKey: "name", fieldTemplate: "name={{value}}", kind: "string", required: true,
        });
    });

    test("Python: path params are rendered as kwargs", () => {
        const get = findSpec("GET", "/agent/{id}");
        const render = buildRenderSchema(get, {
            httpMethod: "GET", httpPath: "/agent/{id}",
            methodChain: ["agent", "get"], methodName: "get",
        }, "python");
        expect(render.callTemplate).toBe("client.agent.get(id={{id}})");
        expect(render.params).toEqual([{ name: "id", kind: "string" }]);
    });

    test("TypeScript: positional path params + `{ body }` envelope", () => {
        const create = findSpec("POST", "/agent/create");
        const render = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
        }, "typescript");
        expect(render.callTemplate).toBe("client.agent.create({ {{__body__}} })");
        expect(render.body?.fields[0].fieldTemplate).toBe(`"name": {{value}}`);
    });

    test("Java: query-only endpoint without a detected request class — callTemplate omits body slot but body.fields are preserved for documentation", () => {
        const list = findSpec("GET", "/agent/list");
        const render = buildRenderSchema(list, {
            httpMethod: "GET", httpPath: "/agent/list",
            methodChain: ["agent", "list"], methodName: "list",
            // requestClassName intentionally absent — defensive guard fires.
        }, "java");
        // No `{{__body__}}` in callTemplate → naïve consumer renders valid Java.
        expect(render.callTemplate).toBe("client.agent().list()");
        // `body` is still surfaced so consumers (docs, richer renderers) can
        // see the field catalog the spec declares — matches Python/TS.
        expect(render.body?.fields).toEqual([
            { jsonKey: "tags", fieldTemplate: ".tags({{value}})", kind: "string", required: false },
        ]);
    });

    test("Java: builder envelope + fluent setters with snake_case→camelCase", () => {
        // Use a synthetic spec field with a snake_case key to exercise the setter conversion.
        const synthetic = {
            httpMethod: "POST", httpPath: "/x",
            pathParams: [], queryParams: [], isStreaming: false,
            requestSchema: {
                type: "object" as const,
                required: ["client_secret"],
                properties: {
                    client_secret: { type: "string" as const },
                },
            },
        };
        const render = buildRenderSchema(synthetic, {
            httpMethod: "POST", httpPath: "/x",
            methodChain: ["x", "create"], methodName: "create",
            requestClassName: "XRequest",
        }, "java");
        expect(render.callTemplate).toBe("client.x().create(XRequest.builder(){{__body__}}.build())");
        expect(render.body?.fieldSeparator).toBe("");
        expect(render.body?.fields[0].fieldTemplate).toBe(".clientSecret({{value}})");
    });

    test("enum field surfaces enumValues and language-specific constants", () => {
        const create = findSpec("POST", "/agent/create");
        const py = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
        }, "python");
        const role = py.body?.fields.find((f) => f.jsonKey === "role");
        expect(role?.kind).toBe("enum");
        expect(role?.enumValues).toEqual(["assistant", "user", "system"]);
        // Python doesn't use enum constants — wire string is accepted.
        expect(role?.enumConstants).toBeUndefined();

        const java = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
            requestClassName: "AgentCreateRequest",
        }, "java");
        const roleJava = java.body?.fields.find((f) => f.jsonKey === "role");
        expect(roleJava?.enumConstants).toEqual({
            assistant: "AgentRole.ASSISTANT",
            user: "AgentRole.USER",
            system: "AgentRole.SYSTEM",
        });
    });

    test("multi-word resource prefix is fully stripped from enum class names", () => {
        // `fhir_provider_Provider` → `Provider` (NOT `provider_Provider`).
        const create = findSpec("POST", "/agent/create");
        const ts = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
        }, "typescript");
        const provider = ts.body?.fields.find((f) => f.jsonKey === "provider");
        expect(provider?.kind).toBe("enum");
        expect(provider?.enumConstants).toEqual({
            epic: "Provider.Epic",
            google_healthcare: "Provider.GoogleHealthcare",
        });

        const java = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
            requestClassName: "AgentCreateRequest",
        }, "java");
        const providerJava = java.body?.fields.find((f) => f.jsonKey === "provider");
        expect(providerJava?.enumConstants).toEqual({
            epic: "Provider.EPIC",
            google_healthcare: "Provider.GOOGLE_HEALTHCARE",
        });
    });

    test("required fields come before optional in the declared order", () => {
        const create = findSpec("POST", "/agent/create");
        const render = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
        }, "python");
        const order = render.body!.fields.map((f) => f.jsonKey);
        // Required: name, role (spec order). Optional: description, provider, tag, tags, scope.
        expect(order).toEqual(["name", "role", "description", "provider", "tag", "tags", "scope"]);
    });

    test("ambiguous $refName (multiple PascalCase segments) omits enumConstants rather than guess", () => {
        // `agent_AgentChatRequest_Scope` could mean `AgentChatRequestScope` OR
        // `AgentChatRequest.Scope` — the spec alone can't disambiguate.
        const create = findSpec("POST", "/agent/create");
        for (const language of ["typescript", "java"] as const) {
            const render = buildRenderSchema(create, {
                httpMethod: "POST", httpPath: "/agent/create",
                methodChain: ["agent", "create"], methodName: "create",
                requestClassName: "AgentCreateRequest",
            }, language);
            const scope = render.body?.fields.find((f) => f.jsonKey === "scope");
            expect(scope?.kind).toBe("enum");
            expect(scope?.enumValues).toEqual(["all", "session"]);
            // enumConstants intentionally absent — consumer falls back to
            // plain string rendering, which still typechecks (Fern's TS enum
            // type unions accept the wire literals; Java compilation fails
            // softly with a clear "unknown identifier" error).
            expect(scope?.enumConstants).toBeUndefined();
        }
    });

    test("passthrough body + query params: query is dropped (rather than corrupting the body slot)", () => {
        // PATCH /agent/{id}/patch-with-filter has a JSON Patch array body
        // (passthrough) AND a `verbose` query param. Appending the query
        // field would make `isPassthroughBody` false and produce broken
        // `{ [...], "verbose": true }` syntax in TS. Fixture asserts the
        // body stays passthrough; query is logged as a warning but dropped.
        const patch = findSpec("PATCH", "/agent/{id}/patch-with-filter");
        const render = buildRenderSchema(patch, {
            httpMethod: "PATCH", httpPath: "/agent/{id}/patch-with-filter",
            methodChain: ["agent", "patch"], methodName: "patch",
        }, "typescript");
        expect(render.body?.fields.length).toBe(1);
        expect(render.body?.fields[0].passthroughBody).toBe(true);
        // callTemplate uses the bare body slot (no `{ ... }` wrap).
        expect(render.callTemplate).toBe("client.agent.patch({{id}}, {{__body__}})");
    });

    test("type:object + oneOf with no properties emits a passthrough body (not an empty fields list)", () => {
        const union = findSpec("POST", "/agent/union");
        for (const language of ["python", "typescript", "java"] as const) {
            const render = buildRenderSchema(union, {
                httpMethod: "POST", httpPath: "/agent/union",
                methodChain: ["agent", "union"], methodName: "union",
                requestClassName: "AgentUnionRequest",
            }, language);
            expect(render.body?.fields.length).toBe(1);
            expect(render.body?.fields[0].passthroughBody).toBe(true);
        }
    });

    test("list of objects: items.nested is populated for TS/Java", () => {
        const create = findSpec("POST", "/agent/create");
        // `tags: Tag[]` — list whose items are a $ref'd object type.
        const ts = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
        }, "typescript");
        const tagsTs = ts.body?.fields.find((f) => f.jsonKey === "tags");
        expect(tagsTs?.kind).toBe("list");
        expect(tagsTs?.items?.kind).toBe("object");
        expect(tagsTs?.items?.nested?.wrap).toBe("{ {{__body__}} }");
        expect(tagsTs?.items?.nested?.fields.map((f) => f.jsonKey)).toEqual(["name", "color"]);

        const java = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
            requestClassName: "AgentCreateRequest",
        }, "java");
        const tagsJava = java.body?.fields.find((f) => f.jsonKey === "tags");
        expect(tagsJava?.items?.nested?.wrap).toBe("Tag.builder(){{__body__}}.build()");
    });

    test("header parameters are not surfaced as body fields", () => {
        // `/agent/list` declares a `tags` query AND an `X-Trace-Id` header.
        // Only the query travels in body.fields; headers are excluded.
        const list = findSpec("GET", "/agent/list");
        const render = buildRenderSchema(list, {
            httpMethod: "GET", httpPath: "/agent/list",
            methodChain: ["agent", "list"], methodName: "list",
        }, "python");
        expect(render.body?.fields.map((f) => f.jsonKey)).toEqual(["tags"]);
    });

    test("nested object fields: TS gets `nested` with `{ ... }` wrap, Java with builder wrap, Python falls back to untyped", () => {
        const create = findSpec("POST", "/agent/create");

        const ts = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
        }, "typescript");
        const tagTs = ts.body?.fields.find((f) => f.jsonKey === "tag");
        expect(tagTs?.kind).toBe("object");
        expect(tagTs?.nested?.wrap).toBe("{ {{__body__}} }");
        expect(tagTs?.nested?.fieldSeparator).toBe(", ");
        expect(tagTs?.nested?.fields.map((f) => f.jsonKey)).toEqual(["name", "color"]);
        expect(tagTs?.nested?.fields[0].fieldTemplate).toBe(`"name": {{value}}`);

        const java = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
            requestClassName: "AgentCreateRequest",
        }, "java");
        const tagJava = java.body?.fields.find((f) => f.jsonKey === "tag");
        expect(tagJava?.nested?.wrap).toBe("Tag.builder(){{__body__}}.build()");
        expect(tagJava?.nested?.fields[0].fieldTemplate).toBe(".name({{value}})");

        const py = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/agent/create",
            methodChain: ["agent", "create"], methodName: "create",
        }, "python");
        const tagPy = py.body?.fields.find((f) => f.jsonKey === "tag");
        // Python: untyped fallback — README contract; consumer renders as dict literal.
        expect(tagPy?.nested).toBeUndefined();
    });

    test("Python: passthrough body uses the SDK's kwarg name (read off the parser, not hard-coded)", () => {
        // The Python SDK's signature is `patch(id, *, request, ...)`. Without
        // the parser's name we'd emit `client.x.method(id="x", [...])` —
        // invalid Python because positional args can't follow kwargs.
        const patch = findSpec("PATCH", "/agent/{id}/patch-with-filter");
        const render = buildRenderSchema(patch, {
            httpMethod: "PATCH", httpPath: "/agent/{id}/patch-with-filter",
            methodChain: ["agent", "patch"], methodName: "patch",
            pathParamNames: ["id"],
            bodyKwargForPassthrough: "request",
        }, "python");
        expect(render.callTemplate).toBe("client.agent.patch(id={{id}}, request={{__body__}})");
        expect(render.body?.fields[0].passthroughBody).toBe(true);
    });

    test("Python: passthrough body falls back to `request=` when the parser didn't surface a name", () => {
        // No mapping for the body kwarg → use Fern's conventional name as a
        // last resort. The fallback keeps things working when codegen changes
        // shape; we'd see a parser warning rather than a runtime miscompile.
        const union = findSpec("POST", "/agent/union");
        const render = buildRenderSchema(union, {
            httpMethod: "POST", httpPath: "/agent/union",
            methodChain: ["agent", "union"], methodName: "union",
        }, "python");
        expect(render.callTemplate).toBe("client.agent.union(request={{__body__}})");
    });

    test("Python: camelCase JSON keys use the SDK kwarg name from the parser", () => {
        // OpenAPI key `resourceType` → SDK kwarg `resource_type` (from the
        // parser's `bodyKwargByJsonKey`). The wire key stays on the field so
        // consumers can still look up `body[jsonKey]`.
        const create = findSpec("POST", "/construe/codes/{code_id}");
        const render = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/construe/codes/{code_id}",
            methodChain: ["construe", "post_code"], methodName: "post_code",
            pathParamNames: ["code_id"],
            bodyKwargByJsonKey: { resourceType: "resource_type", fhir_path: "fhir_path" },
        }, "python");
        const resourceType = render.body?.fields.find((f) => f.jsonKey === "resourceType");
        expect(resourceType?.jsonKey).toBe("resourceType");
        expect(resourceType?.fieldTemplate).toBe("resource_type={{value}}");
        const fhirPath = render.body?.fields.find((f) => f.jsonKey === "fhir_path");
        expect(fhirPath?.fieldTemplate).toBe("fhir_path={{value}}");
    });

    test("Python: body field falls back to the wire key when the parser didn't map it", () => {
        // No bodyKwargByJsonKey → render uses the wire key verbatim. Surfaces
        // a visible artifact (`resourceType=` in the rendered Python) so the
        // miss is obvious instead of being papered over with a snake_case
        // heuristic.
        const create = findSpec("POST", "/construe/codes/{code_id}");
        const render = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/construe/codes/{code_id}",
            methodChain: ["construe", "post_code"], methodName: "post_code",
        }, "python");
        const resourceType = render.body?.fields.find((f) => f.jsonKey === "resourceType");
        expect(resourceType?.fieldTemplate).toBe("resourceType={{value}}");
    });

    test("Python: path-param kwarg label comes from `pathParamNames`; the placeholder uses the spec name", () => {
        // OpenAPI `codeID` → SDK identifier `code_id`. The placeholder
        // `{{codeID}}` stays in the OpenAPI form so consumers can keep
        // passing a language-agnostic `pathParams` map keyed by spec name.
        const create = findSpec("POST", "/construe/codes/{code_id}");
        const render = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/construe/codes/{code_id}",
            methodChain: ["construe", "post_code"], methodName: "post_code",
            pathParamNames: ["code_id"],
            bodyKwargByJsonKey: { resourceType: "resource_type", fhir_path: "fhir_path" },
        }, "python");
        expect(render.params).toEqual([{ name: "codeID", kind: "string" }]);
        expect(render.callTemplate).toBe("client.construe.post_code(code_id={{codeID}}, {{__body__}})");
    });

    test("Python: path-param kwarg label falls back to the spec name when the parser is silent", () => {
        const create = findSpec("POST", "/construe/codes/{code_id}");
        const render = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/construe/codes/{code_id}",
            methodChain: ["construe", "post_code"], methodName: "post_code",
        }, "python");
        // No SDK-side name → spec name fills both sides of the kwarg.
        expect(render.callTemplate).toBe("client.construe.post_code(codeID={{codeID}}, {{__body__}})");
    });

    test("TypeScript: object-literal keys stay in the wire form regardless of parser data", () => {
        // The TS body slot is `{ ... }` and the keys are wire keys — only
        // Python kwargs route through `bodyKwargByJsonKey`. Confirms the
        // refactor didn't accidentally apply Python-style remapping
        // cross-language.
        const create = findSpec("POST", "/construe/codes/{code_id}");
        const render = buildRenderSchema(create, {
            httpMethod: "POST", httpPath: "/construe/codes/{code_id}",
            methodChain: ["construe", "postCode"], methodName: "postCode",
            bodyKwargByJsonKey: { resourceType: "resource_type" },
        }, "typescript");
        const resourceType = render.body?.fields.find((f) => f.jsonKey === "resourceType");
        expect(resourceType?.fieldTemplate).toBe(`"resourceType": {{value}}`);
    });

    test("GET endpoint with only query params produces a body schema of those params", () => {
        const list = findSpec("GET", "/agent/list");
        const render = buildRenderSchema(list, {
            httpMethod: "GET", httpPath: "/agent/list",
            methodChain: ["agent", "list"], methodName: "list",
        }, "python");
        expect(render.body?.fields).toEqual([
            { jsonKey: "tags", fieldTemplate: "tags={{value}}", kind: "string", required: false },
        ]);
    });
});

// ============================================================
// End-to-end manifest
// ============================================================

describe("buildManifest end-to-end", () => {
    const metadata = {
        generatorName: "fernapi/fern-python-sdk",
        sdkVersion: "0.0.0",
        originGitCommit: "fixture-abc123",
    };

    test("Python: matches all fixture-covered spec endpoints", () => {
        const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
        const mappings = createPythonParser().parseEndpoints(path.join(FIXTURES, "python"));
        const manifest = buildManifest(spec, mappings, "python", "phenoml", metadata);
        expect(Object.keys(manifest.examples).sort()).toEqual([
            "DELETE /agent/{id}",
            "GET /agent/list",
            "GET /agent/{id}",
            "PATCH /agent/{id}/patch-with-filter",
            "POST /agent/create",
            "POST /agent/stream",
            "POST /construe/codes/{code_id}",
        ]);
    });

    test("Python end-to-end: parser-extracted names drive the rendered call (no convention encoded)", () => {
        // Wires up spec + parser + render-rules and asserts the rendered
        // Python call matches what the SDK actually expects — exercising
        // pathParamNames, bodyKwargByJsonKey, and bodyKwargForPassthrough
        // end-to-end.
        const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
        const mappings = createPythonParser().parseEndpoints(path.join(FIXTURES, "python"));
        const manifest = buildManifest(spec, mappings, "python", "phenoml", metadata);

        // camelCase path param + camelCase JSON key → SDK identifiers.
        expect(manifest.examples["POST /construe/codes/{code_id}"].render?.callTemplate).toBe(
            "client.agent.post_code(code_id={{codeID}}, {{__body__}})",
        );
        const postCodeFields = manifest.examples["POST /construe/codes/{code_id}"].render?.body?.fields ?? [];
        expect(postCodeFields.find((f) => f.jsonKey === "resourceType")?.fieldTemplate)
            .toBe("resource_type={{value}}");

        // Passthrough body + path param: kwarg name `request` (from the
        // signature) preserves Python's "kwargs can't follow positional"
        // rule.
        expect(manifest.examples["PATCH /agent/{id}/patch-with-filter"].render?.callTemplate)
            .toBe("client.agent.patch_with_filter(id={{id}}, request={{__body__}})");
    });

    test("includes discriminator-style example fields verbatim (the original bug fix)", () => {
        // The fixture spec uses `role: "assistant"` as a flat field; pulled
        // verbatim from `example` it must appear in request.body.
        const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
        const mappings = createPythonParser().parseEndpoints(path.join(FIXTURES, "python"));
        const manifest = buildManifest(spec, mappings, "python", "phenoml", metadata);
        expect(manifest.examples["POST /agent/create"].request.body).toEqual({
            name: "Medical Assistant",
            description: "Helps with FHIR coding",
            role: "assistant",
        });
    });

    test("streaming endpoint: response.body null + streaming:true", () => {
        const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
        const mappings = createPythonParser().parseEndpoints(path.join(FIXTURES, "python"));
        const manifest = buildManifest(spec, mappings, "python", "phenoml", metadata);
        expect(manifest.examples["POST /agent/stream"].response).toEqual({
            body: null,
            streaming: true,
        });
    });

    test("TypeScript end-to-end", () => {
        const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
        const mappings = createTypeScriptParser().parseEndpoints(path.join(FIXTURES, "typescript"));
        const manifest = buildManifest(spec, mappings, "typescript", "phenoml",
            { ...metadata, generatorName: "fernapi/fern-typescript-sdk" });
        expect(Object.keys(manifest.examples).sort()).toHaveLength(5);
        expect(manifest.examples["POST /agent/create"].render?.callTemplate)
            .toBe("client.agent.create({ {{__body__}} })");
    });

    test("renderRules in the manifest carry language-appropriate literals", () => {
        const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
        const mappings = createPythonParser().parseEndpoints(path.join(FIXTURES, "python"));
        const py = buildManifest(spec, mappings, "python", "phenoml", metadata);
        expect(py.renderRules.trueLiteral).toBe("True");
        expect(py.renderRules.nullLiteral).toBe("None");
        expect(py.renderRules.listLiteral).toBe("[{{items}}]");

        const java = buildManifest(spec, mappings, "java", "com.phenoml",
            { ...metadata, generatorName: "fernapi/fern-java-sdk" });
        expect(java.renderRules.trueLiteral).toBe("true");
        expect(java.renderRules.nullLiteral).toBe("null");
        expect(java.renderRules.listLiteral).toBe("Arrays.asList({{items}})");
    });

    test("Java end-to-end", () => {
        const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
        const mappings = createJavaParser().parseEndpoints(path.join(FIXTURES, "java"));
        const manifest = buildManifest(spec, mappings, "java", "com.phenoml",
            { ...metadata, generatorName: "fernapi/fern-java-sdk" });
        expect(Object.keys(manifest.examples).sort()).toHaveLength(5);
        // Java callTemplate uses .accessor() chain + builder envelope.
        expect(manifest.examples["POST /agent/create"].render?.callTemplate)
            .toBe("client.agent().create(AgentCreateRequest.builder(){{__body__}}.build())");
    });
});

// ============================================================
// Java accessor map (a quirk worth keeping)
// ============================================================

describe("bulk-failure guards", () => {
    test("Java parser throws when raw clients exist but produce 0 endpoints (codegen drift)", () => {
        // Write a temp SDK tree with a Raw client whose return type doesn't
        // match the expected `PhenoMLHttpResponse<T>` pattern — the parser
        // should reject this loudly rather than silently emitting nothing.
        const tmp = path.join(import.meta.dir, "tmp-broken-java");
        const javaPkg = path.join(tmp, "src/main/java/com/x/api/resources/foo");
        fs.mkdirSync(javaPkg, { recursive: true });
        fs.writeFileSync(
            path.join(javaPkg, "RawFooClient.java"),
            "package com.x.api.resources.foo;\npublic class RawFooClient {\n" +
            "  public SomeOtherWrapper<String> doStuff() { return null; }\n}\n",
        );
        try {
            expect(() => createJavaParser().parseEndpoints(tmp)).toThrow(/extracted 0 endpoints/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test("Python parser throws when raw_client.py files exist but produce 0 endpoints", () => {
        const tmp = path.join(import.meta.dir, "tmp-broken-py");
        const pkg = path.join(tmp, "src/x/foo");
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(
            path.join(pkg, "raw_client.py"),
            "class RawFooClient:\n    def __init__(self): pass\n",
        );
        try {
            expect(() => createPythonParser().parseEndpoints(tmp)).toThrow(/extracted 0 endpoints/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test("TypeScript parser throws when Client.ts files exist but produce 0 endpoints", () => {
        const tmp = path.join(import.meta.dir, "tmp-broken-ts");
        const dir = path.join(tmp, "src/api/resources/foo/client");
        fs.mkdirSync(dir, { recursive: true });
        // Class without any `__methodName` impl matches the file pattern but
        // yields no endpoints.
        fs.writeFileSync(
            path.join(dir, "Client.ts"),
            "export class FooClient { public greet() { return 'hi'; } }\n",
        );
        try {
            expect(() => createTypeScriptParser().parseEndpoints(tmp)).toThrow(/extracted 0 endpoints/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test("loadSpec throws when paths exist but no operation uses a recognized HTTP method", () => {
        const tmp = path.join(import.meta.dir, "tmp-broken-spec.json");
        fs.writeFileSync(tmp, JSON.stringify({
            openapi: "3.0.3",
            info: { title: "x", version: "1" },
            paths: { "/foo": { options: { responses: { "200": { description: "ok" } } } } },
        }));
        try {
            expect(() => loadSpec(tmp)).toThrow(/loaded 0 endpoints/);
        } finally {
            fs.rmSync(tmp, { force: true });
        }
    });

    test("buildManifest throws when spec and SDK both have endpoints but none align", () => {
        const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
        // SDK mapping with paths that don't match any spec endpoint — simulates
        // a path-normalization regression where the parser's templates drift.
        const orphanMappings = [{
            httpMethod: "GET", httpPath: "/totally/different/path",
            methodChain: ["other"], methodName: "other",
        }];
        expect(() => buildManifest(spec, orphanMappings, "python", "x", {
            generatorName: "x", sdkVersion: "1", originGitCommit: "1",
        })).toThrow(/Joined 0 of/);
    });
});

describe("javaBuildAccessorMap", () => {
    test("maps resource directories to camelCase accessor method names", () => {
        const map = javaBuildAccessorMap(path.join(FIXTURES, "java/src/main/java"));
        // PhenomlClient declares `agent()` → agent dir (already matches name)
        // and `fhirProvider()` → fhirprovider dir (lowercased dir, camelCase
        // accessor). The map keys are absolute directory paths.
        const entries = [...map.entries()].map(([dir, name]) => [path.basename(dir), name]);
        expect(entries.sort()).toEqual([
            ["agent", "agent"],
            ["fhirprovider", "fhirProvider"],
        ]);
    });

    test("javaDeriveMethodChain remaps lowercased dir to camelCase accessor when the map provides one", () => {
        const map = javaBuildAccessorMap(path.join(FIXTURES, "java/src/main/java"));
        const resourcesDir = path.join(FIXTURES, "java/src/main/java/com/phenoml/api/resources");
        const fhirProvider = path.join(resourcesDir, "fhirprovider/RawFhirProviderClient.java");
        const chain = javaDeriveMethodChain(fhirProvider, resourcesDir, map);
        expect(chain).toEqual(["fhirProvider"]);
    });
});
