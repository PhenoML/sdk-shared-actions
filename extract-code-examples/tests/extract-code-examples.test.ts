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
        expect(endpoints.length).toBe(6);
        const keys = endpoints.map((e) => `${e.httpMethod} ${e.httpPath}`).sort();
        expect(keys).toEqual([
            "DELETE /agent/{id}",
            "GET /agent/list",
            "GET /agent/{id}",
            "POST /agent/create",
            "POST /agent/dual-content",
            "POST /agent/stream",
        ]);
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
    test("extracts all sync-class endpoints, skipping async twin", () => {
        const file = path.join(FIXTURES, "python/src/phenoml/agent/raw_client.py");
        const pkgRoot = path.join(FIXTURES, "python/src/phenoml");
        const endpoints = pyExtractEndpoints(file, pkgRoot);
        const keys = endpoints.map((e) => `${e.httpMethod} ${e.httpPath}`).sort();
        expect(keys).toEqual([
            "DELETE /agent/{id}",
            "GET /agent/list",
            "GET /agent/{id}",
            "POST /agent/create",
            "POST /agent/stream",
        ]);
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
            "POST /agent/create",
            "POST /agent/stream",
        ]);
    });

    test("rebuilds template-literal paths with bare `{name}`", () => {
        const file = path.join(FIXTURES, "typescript/src/api/resources/agent/client/Client.ts");
        const endpoints = tsExtractEndpoints(file);
        const get = endpoints.find((e) => e.httpMethod === "GET" && e.httpPath === "/agent/{id}");
        expect(get?.methodChain).toEqual(["agent", "get"]);
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
        // Required: name, role (spec order). Optional: description, provider, tag.
        expect(order).toEqual(["name", "role", "description", "provider", "tag"]);
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

    test("Python: matches all five spec endpoints", () => {
        const spec = loadSpec(path.join(FIXTURES, "openapi-shared.json"));
        const mappings = createPythonParser().parseEndpoints(path.join(FIXTURES, "python"));
        const manifest = buildManifest(spec, mappings, "python", "phenoml", metadata);
        expect(Object.keys(manifest.examples).sort()).toEqual([
            "DELETE /agent/{id}",
            "GET /agent/list",
            "GET /agent/{id}",
            "POST /agent/create",
            "POST /agent/stream",
        ]);
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

describe("javaBuildAccessorMap", () => {
    test("returns an empty map when no top-level *Client.java files exist", () => {
        const map = javaBuildAccessorMap(path.join(FIXTURES, "java/src/main/java"));
        // The fixture only ships the Raw client (no `*Client.java` exposing
        // an accessor), so the map is empty — chain falls back to the dir name.
        expect(map.size).toBe(0);
    });
});
