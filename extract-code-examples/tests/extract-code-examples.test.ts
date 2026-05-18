import { afterAll, describe, expect, test } from "bun:test";
import * as path from "path";
import {
    buildManifest,
    camelToSnake,
    createJavaParser,
    createPythonParser,
    createTypeScriptParser,
    deriveBodyFromKwargs,
    isBalancedParens,
    buildJavaBodySchema,
    buildPythonRenderSchema,
    buildTsRenderSchema,
    findJavaClassFile,
    javaBuildAccessorMap,
    javaClassifySignatureParams,
    javaCountBraceDelta,
    javaDeriveMethodChain,
    javaExtractConcatenatedString,
    javaExtractSetBody,
    javaParseSignatureParams,
    javaUnescape,
    parseJavaClass,
    parseJavaEnumValues,
    parseJavaFieldDeclarations,
    parseJavaJsonIgnoredFields,
    parseJavaJsonProperties,
    parseJavaStagedBuilderOrder,
    pyExtractEnumValues,
    pyExtractHeaderKwargs,
    pyExtractMethodKwargs,
    pyInferKind,
    pyStripOptional,
    pyUnwrapList,
    tsExtractMethodSignatureInfo,
    tsInferKind,
    tsParseRequestInterface,
    tsResolveRequestInterfacePath,
    normalizePath,
    normalizePathParams,
    pyDeriveMethodChain,
    pyExtractBodyParamMap,
    pyExtractBodyShape,
    pyExtractHttpMethod,
    pyExtractRequestPath,
    pyParseKwargs,
    truncateAfterMatchingParen,
} from "../index";

const FIXTURES = path.join(import.meta.dir, "fixtures");

// Silence the parsers' progress logging to keep test output clean. Set at
// module load so parser calls in describe-block scope (which run during
// test registration, before beforeAll fires) are also quiet.
const originalConsoleError = console.error;
console.error = () => {};
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
    test("converts backslashes to forward slashes", () => {
        expect(normalizePath("agent\\create")).toBe("/agent/create");
    });
});

describe("normalizePathParams", () => {
    test("converts camelCase parameter names to snake_case", () => {
        expect(normalizePathParams("/codes/{codeID}")).toBe("/codes/{code_id}");
        expect(normalizePathParams("/users/{userId}/posts/{postId}")).toBe(
            "/users/{user_id}/posts/{post_id}",
        );
    });
    test("leaves already snake_case names unchanged", () => {
        expect(normalizePathParams("/codes/{code_id}")).toBe("/codes/{code_id}");
    });
    test("does not touch literal segments", () => {
        expect(normalizePathParams("/agent/list")).toBe("/agent/list");
    });
});

describe("camelToSnake", () => {
    test("simple cases", () => {
        expect(camelToSnake("codeId")).toBe("code_id");
        expect(camelToSnake("userId")).toBe("user_id");
    });
    test("acronym runs", () => {
        expect(camelToSnake("HTTPResponse")).toBe("http_response");
        expect(camelToSnake("getURLPath")).toBe("get_url_path");
    });
    test("already snake_case is unchanged", () => {
        expect(camelToSnake("already_snake")).toBe("already_snake");
    });
});

describe("isBalancedParens", () => {
    test("balanced", () => {
        expect(isBalancedParens("f(a, (b, c))")).toBe(true);
        expect(isBalancedParens("")).toBe(true);
    });
    test("unbalanced", () => {
        expect(isBalancedParens("f(a, b")).toBe(false);
        expect(isBalancedParens(")(")).toBe(false);
    });
});

describe("truncateAfterMatchingParen", () => {
    test("drops trailing `:` from a `for _ in ...:` wrapper", () => {
        const input = 'client.agent.stream_chat(\n    agent_id="agent-123",\n):';
        expect(truncateAfterMatchingParen(input)).toBe(
            'client.agent.stream_chat(\n    agent_id="agent-123",\n)',
        );
    });
    test("respects nested parens before the outer close", () => {
        const input = "client.foo.bar(\n    items=(1, 2, 3),\n):";
        expect(truncateAfterMatchingParen(input)).toBe(
            "client.foo.bar(\n    items=(1, 2, 3),\n)",
        );
    });
    test("is a no-op when the string already ends at the matching paren", () => {
        expect(truncateAfterMatchingParen("client.foo.bar()")).toBe("client.foo.bar()");
    });
    test("returns the input unchanged when no parens are present", () => {
        expect(truncateAfterMatchingParen("no parens here")).toBe("no parens here");
    });
});

// ============================================================
// Java brace tracking — verifies the lexer that ignores braces
// inside strings, chars, comments, and text blocks.
// ============================================================

describe("javaCountBraceDelta", () => {
    test("counts plain braces", () => {
        const s = { inBlockComment: false, inTextBlock: false };
        expect(javaCountBraceDelta("if (x) { y(); }", s)).toBe(0);
        expect(javaCountBraceDelta("class Foo {", s)).toBe(1);
        expect(javaCountBraceDelta("}", s)).toBe(-1);
    });

    test("ignores braces inside string literals", () => {
        const s = { inBlockComment: false, inTextBlock: false };
        // Without the fix this would be -1 (the `}` inside the string was counted).
        expect(javaCountBraceDelta('String j = "{\\"key\\": \\"value\\"}";', s)).toBe(0);
    });

    test("ignores braces inside char literals", () => {
        const s = { inBlockComment: false, inTextBlock: false };
        expect(javaCountBraceDelta("char c = '{';", s)).toBe(0);
    });

    test("ignores braces inside line comments", () => {
        const s = { inBlockComment: false, inTextBlock: false };
        expect(javaCountBraceDelta("int x = 1; // open { brace", s)).toBe(0);
    });

    test("tracks multi-line block comments across lines", () => {
        const s = { inBlockComment: false, inTextBlock: false };
        expect(javaCountBraceDelta("/* open {", s)).toBe(0);
        expect(s.inBlockComment).toBe(true);
        // Inside the block comment — braces still ignored
        expect(javaCountBraceDelta("still in } comment", s)).toBe(0);
        expect(javaCountBraceDelta("end */ class A {", s)).toBe(1);
        expect(s.inBlockComment).toBe(false);
    });

    test("tracks multi-line text blocks across lines", () => {
        const s = { inBlockComment: false, inTextBlock: false };
        expect(javaCountBraceDelta('String j = """', s)).toBe(0);
        expect(s.inTextBlock).toBe(true);
        expect(javaCountBraceDelta('  {"key": "val"}', s)).toBe(0);
        expect(javaCountBraceDelta('  """;', s)).toBe(0);
        expect(s.inTextBlock).toBe(false);
    });

    test("handles escaped quotes inside strings", () => {
        const s = { inBlockComment: false, inTextBlock: false };
        expect(javaCountBraceDelta('"a\\"b" + "{" + "}"', s)).toBe(0);
    });
});

// ============================================================
// Java helpers
// ============================================================

describe("javaParseSignatureParams", () => {
    test("parses a single-line signature", () => {
        const lines = ["    public PhenomlClientHttpResponse<Foo> bar(String id, CohortRequest request) {"];
        expect(javaParseSignatureParams(lines, 0)).toEqual([
            { type: "String", name: "id" },
            { type: "CohortRequest", name: "request" },
        ]);
    });
    test("parses a multi-line signature", () => {
        const lines = [
            "    public PhenomlClientHttpResponse<Foo> bar(",
            "            String id,",
            "            CohortRequest request,",
            "            RequestOptions requestOptions) {",
        ];
        expect(javaParseSignatureParams(lines, 0)).toEqual([
            { type: "String", name: "id" },
            { type: "CohortRequest", name: "request" },
            { type: "RequestOptions", name: "requestOptions" },
        ]);
    });
    test("keeps generic types intact", () => {
        // The naive split-on-space approach would slice `Optional<List<String>>`
        // into pieces; the param-list splitter must respect angle nesting.
        const lines = ["    public PhenomlClientHttpResponse<Foo> bar(Optional<List<String>> tags) {"];
        expect(javaParseSignatureParams(lines, 0)).toEqual([
            { type: "Optional<List<String>>", name: "tags" },
        ]);
    });
});

describe("javaClassifySignatureParams", () => {
    test("treats the trailing *Request param as the body", () => {
        const result = javaClassifySignatureParams([
            { type: "String", name: "id" },
            { type: "CohortRequest", name: "request" },
            { type: "RequestOptions", name: "requestOptions" },
        ]);
        expect(result).toEqual({
            requestClass: "CohortRequest",
            bodyParamName: "request",
            positional: [{ name: "id", type: "String" }],
        });
    });
    test("returns no requestClass when no param ends in 'Request'", () => {
        // GET endpoints with only path params look like this — there's nothing
        // to wire into a body schema, just positional path args.
        const result = javaClassifySignatureParams([
            { type: "String", name: "id" },
            { type: "RequestOptions", name: "requestOptions" },
        ]);
        expect(result.requestClass).toBeNull();
        expect(result.bodyParamName).toBeNull();
        expect(result.positional).toEqual([{ name: "id", type: "String" }]);
    });
});

describe("javaUnescape", () => {
    test("handles common escapes", () => {
        expect(javaUnescape("a\\nb")).toBe("a\nb");
        expect(javaUnescape("a\\tb")).toBe("a\tb");
        expect(javaUnescape('a\\"b')).toBe('a"b');
    });
    test("preserves a literal backslash-backslash", () => {
        // Critical case: the chained-regex bug. The input \\n at runtime is
        // backslash + backslash + n; the unescape must yield backslash + n,
        // not a newline.
        expect(javaUnescape("\\\\n")).toBe("\\n");
    });
});

describe("javaExtractSetBody", () => {
    test("extracts a JSON body from setBody()", () => {
        const lines = [
            "server.enqueue(new MockResponse()",
            '    .setBody("{\\"token\\":\\"abc\\"}")',
            "    .setResponseCode(200));",
        ];
        expect(javaExtractSetBody(lines, 0)).toBe('{"token":"abc"}');
    });

    test("resolves setBody(TestResources.loadResource(...)) to fixture file contents", () => {
        const root = path.join(FIXTURES, "java-accessor");
        const lines = [
            "server.enqueue(new MockResponse()",
            "    .setResponseCode(200)",
            '    .setBody(TestResources.loadResource("/wire-tests/FhirProviderWireTest_testCreate_response.json")));',
        ];
        const body = javaExtractSetBody(lines, 0, root);
        expect(body).not.toBeNull();
        expect(JSON.parse(body!)).toMatchObject({ success: true });
    });

    test("returns null without rootDir when only TestResources.loadResource is present", () => {
        const lines = [
            "server.enqueue(new MockResponse()",
            '    .setBody(TestResources.loadResource("/wire-tests/whatever.json")));',
        ];
        expect(javaExtractSetBody(lines, 0)).toBeNull();
    });
});

describe("javaExtractConcatenatedString", () => {
    test("concatenates multi-line Java string fragments", () => {
        const lines = [
            'String expected = "" + "{\\n"',
            '    + "  \\"a\\": 1,\\n"',
            '    + "  \\"b\\": 2\\n"',
            '    + "}";',
        ];
        const result = javaExtractConcatenatedString(lines, 0);
        expect(result).toBe('{\n  "a": 1,\n  "b": 2\n}');
    });

    test("resolves expected* = TestResources.loadResource(...) to fixture file contents", () => {
        const root = path.join(FIXTURES, "java-accessor");
        const lines = [
            "String expectedResponseBody =",
            '        TestResources.loadResource("/wire-tests/FhirProviderWireTest_testCreate_response.json");',
        ];
        const body = javaExtractConcatenatedString(lines, 0, root);
        expect(body).not.toBeNull();
        expect(JSON.parse(body!)).toMatchObject({ success: true });
    });
});

describe("javaBuildAccessorMap", () => {
    const root = path.join(FIXTURES, "java-accessor");
    const javaDir = path.join(root, "src/main/java");

    test("maps directory paths to camelCase accessor method names", () => {
        const map = javaBuildAccessorMap(javaDir);
        expect(map.get(path.join(javaDir, "com/phenoml/api/resources/fhirprovider"))).toBe(
            "fhirProvider",
        );
        expect(map.get(path.join(javaDir, "com/phenoml/api/resources/tools/mcpserver"))).toBe(
            "mcpServer",
        );
        expect(map.get(path.join(javaDir, "com/phenoml/api/resources/tools"))).toBe("tools");
    });

    test("returns an empty map when the source directory is missing", () => {
        expect(javaBuildAccessorMap(path.join(root, "does/not/exist")).size).toBe(0);
    });

    test("distinguishes duplicate Client basenames via package + imports", () => {
        // The fixture has two `ToolsClient.java` files: the top-level one at
        // resources/tools/, and a nested one at resources/tools/mcpserver/tools/.
        // A basename-only index would collapse to one map entry and leave the
        // other directory unmapped.
        const map = javaBuildAccessorMap(javaDir);
        expect(map.get(path.join(javaDir, "com/phenoml/api/resources/tools"))).toBe("tools");
        expect(
            map.get(path.join(javaDir, "com/phenoml/api/resources/tools/mcpserver/tools")),
        ).toBe("tools");
    });
});

describe("javaDeriveMethodChain", () => {
    test("derives chain from path under resources/", () => {
        const chain = javaDeriveMethodChain(
            "/sdk/src/main/java/com/phenoml/api/resources/authtoken/auth/RawAuthClient.java",
            "/sdk/src/main/java/com/phenoml/api/resources",
        );
        expect(chain).toEqual(["authtoken", "auth"]);
    });

    test("remaps lowercased directory segments to camelCase accessor names via the map", () => {
        const resourcesDir = "/sdk/src/main/java/com/phenoml/api/resources";
        const accessorMap = new Map<string, string>([
            [`${resourcesDir}/fhirprovider`, "fhirProvider"],
        ]);
        const chain = javaDeriveMethodChain(
            `${resourcesDir}/fhirprovider/RawFhirProviderClient.java`,
            resourcesDir,
            accessorMap,
        );
        expect(chain).toEqual(["fhirProvider"]);
    });

    test("remaps nested segments independently, leaving already-matching segments alone", () => {
        const resourcesDir = "/sdk/src/main/java/com/phenoml/api/resources";
        const accessorMap = new Map<string, string>([
            [`${resourcesDir}/tools`, "tools"],
            [`${resourcesDir}/tools/mcpserver`, "mcpServer"],
        ]);
        const chain = javaDeriveMethodChain(
            `${resourcesDir}/tools/mcpserver/RawMcpServerClient.java`,
            resourcesDir,
            accessorMap,
        );
        expect(chain).toEqual(["tools", "mcpServer"]);
    });

    test("falls back to the lowercased directory name when no accessor is registered", () => {
        const resourcesDir = "/sdk/src/main/java/com/phenoml/api/resources";
        const chain = javaDeriveMethodChain(
            `${resourcesDir}/authtoken/auth/RawAuthClient.java`,
            resourcesDir,
            new Map(),
        );
        expect(chain).toEqual(["authtoken", "auth"]);
    });
});

// ============================================================
// Python helpers
// ============================================================

describe("pyDeriveMethodChain", () => {
    test("filters out 'resources' segments", () => {
        expect(pyDeriveMethodChain("cohort/raw_client.py")).toEqual(["cohort"]);
        expect(pyDeriveMethodChain("agent/resources/prompts/raw_client.py")).toEqual([
            "agent",
            "prompts",
        ]);
        expect(pyDeriveMethodChain("tools/resources/mcp_server/raw_client.py")).toEqual([
            "tools",
            "mcp_server",
        ]);
    });
});

describe("pyExtractRequestPath", () => {
    test("extracts a simple f-string path", () => {
        const lines = ['_response = self._client_wrapper.httpx_client.request(', '    f"agent/list",'];
        expect(pyExtractRequestPath(lines, 0)).toBe("agent/list");
    });
    test("strips jsonable_encoder() wrappers from path parameters", () => {
        const lines = [
            "_response = self._client_wrapper.httpx_client.request(",
            '    f"agent/{jsonable_encoder(agent_id)}",',
        ];
        expect(pyExtractRequestPath(lines, 0)).toBe("agent/{agent_id}");
    });
    test("strips encode_path_param() wrappers (current Fern Python helper)", () => {
        // Fern's current Python generator emits `encode_path_param(...)`.
        // Older versions used jsonable_encoder/url_encode — the parser
        // accepts any single-function wrapper.
        const lines = [
            "_response = self._client_wrapper.httpx_client.request(",
            '    f"agent/{encode_path_param(id)}",',
        ];
        expect(pyExtractRequestPath(lines, 0)).toBe("agent/{id}");
    });
    test("leaves bare {param} placeholders unchanged", () => {
        const lines = [
            "_response = self._client_wrapper.httpx_client.request(",
            '    f"agent/{id}",',
        ];
        expect(pyExtractRequestPath(lines, 0)).toBe("agent/{id}");
    });
});

describe("pyExtractHttpMethod", () => {
    test("finds method= kwarg", () => {
        const lines = [
            'self._client_wrapper.httpx_client.request(',
            '    "path",',
            '    method="POST",',
        ];
        expect(pyExtractHttpMethod(lines, 0)).toBe("POST");
    });
});

describe("pyExtractBodyParamMap", () => {
    test("maps kwarg name → JSON field name for each top-level entry", () => {
        const lines = [
            "self._client_wrapper.httpx_client.request(",
            '    "agent/stream-chat",',
            '    method="POST",',
            "    json={",
            '        "message": message,',
            '        "agent_id": agent_id,',
            "    },",
            "    headers={",
            '        "phenoml-on-behalf-of": str(phenoml_on_behalf_of),',
            "    },",
            ")",
        ];
        // Header identifiers must NOT appear in the map — they live in a
        // sibling `headers={...}` dict, which the walker exits via depth=0.
        expect(pyExtractBodyParamMap(lines, 0)).toEqual({
            message: "message",
            agent_id: "agent_id",
        });
    });
    test("preserves aliased JSON field names distinct from kwarg names", () => {
        // Fern aliases (e.g., snake_case kwarg → camelCase wire field).
        // The map must keep the wire side so the manifest reports the
        // actual HTTP body shape, not the SDK call's local names.
        const lines = [
            "    json={",
            '        "someField": some_field,',
            '        "anotherWireKey": another_kwarg,',
            "    },",
        ];
        expect(pyExtractBodyParamMap(lines, 0)).toEqual({
            some_field: "someField",
            another_kwarg: "anotherWireKey",
        });
    });
    test("ignores nested-dict sub-fields (depth > 1)", () => {
        const lines = [
            "    json={",
            '        "name": name,',
            '        "extra": {',
            '            "key": should_not_appear,',
            "        },",
            '        "after": after_kwarg,',
            "    },",
        ];
        expect(pyExtractBodyParamMap(lines, 0)).toEqual({ name: "name", after_kwarg: "after" });
    });
    test("returns null when no `json={` dict literal is present", () => {
        // GET endpoints have no `json=` arg; `json=body_var` (non-literal)
        // also returns null so callers fall back to the old heuristic.
        expect(pyExtractBodyParamMap(["self._client_wrapper.httpx_client.request(", '    "foo",', ")"], 0)).toBeNull();
        expect(pyExtractBodyParamMap(["    json=body_var,"], 0)).toBeNull();
    });
    test("returns empty map for an empty `json={}`", () => {
        expect(pyExtractBodyParamMap(["    json={},"], 0)).toEqual({});
    });
    test("unwraps `object_=<kwarg>` from Fern's serialization helper", () => {
        // Current Fern emits this wrapper for fields with serialization
        // metadata. The kwarg lives in the `object_=` arg, not as the
        // wrapper's own name. (Reported against ElevenLabs' python SDK.)
        const lines = [
            "    json={",
            '        "conversation_config": convert_and_respect_annotation_metadata(',
            "            object_=conversation_config,",
            "            annotation=AgentConversationConfig,",
            '            direction="write",',
            "        ),",
            '        "name": name,',
            "    },",
        ];
        expect(pyExtractBodyParamMap(lines, 0)).toEqual({
            conversation_config: "conversation_config",
            name: "name",
        });
    });
    test("unwraps positional-arg wrappers like jsonable_encoder(value)", () => {
        const lines = [
            "    json={",
            '        "id": jsonable_encoder(id),',
            '        "tag": jsonable_encoder(tag),',
            "    },",
        ];
        expect(pyExtractBodyParamMap(lines, 0)).toEqual({ id: "id", tag: "tag" });
    });
    test("drops fields whose wrapper has no recoverable kwarg", () => {
        // A wrapper with only kwarg-style args (none `object_=`) can't be
        // unwrapped. Returning null drops the field rather than emitting
        // the wrapper function name, which would never match an SDK kwarg.
        const lines = [
            "    json={",
            '        "ok": helper(named=value, other=thing),',
            '        "name": name,',
            "    },",
        ];
        expect(pyExtractBodyParamMap(lines, 0)).toEqual({ name: "name" });
    });
});

describe("pyExtractBodyShape", () => {
    test("returns dict shape with fields and inline literals", () => {
        // The FHIR bundle case: `resourceType` is a fixed string literal
        // baked into the raw client, not sourced from a kwarg. Without
        // capturing it as a literal, the manifest body would silently
        // omit a wire field the SDK actually sends.
        const lines = [
            "self._client_wrapper.httpx_client.request(",
            '    "fhir-provider/{id}/fhir",',
            '    method="POST",',
            "    json={",
            '        "total": total,',
            '        "entry": convert_and_respect_annotation_metadata(',
            "            object_=entry, annotation=Foo, direction=\"write\"",
            "        ),",
            '        "resourceType": "Bundle",',
            "    },",
            ")",
        ];
        expect(pyExtractBodyShape(lines, 0)).toEqual({
            fields: { total: "total", entry: "entry" },
            literals: { resourceType: "Bundle" },
        });
    });

    test("captures numeric, bool, and null inline literals", () => {
        const lines = [
            "    json={",
            '        "version": 2,',
            '        "active": True,',
            '        "verified": False,',
            '        "metadata": None,',
            '        "ratio": 1.5,',
            "    },",
        ];
        expect(pyExtractBodyShape(lines, 0)).toEqual({
            fields: {},
            literals: { version: 2, active: true, verified: false, metadata: null, ratio: 1.5 },
        });
    });

    test("omits literals from result when none are present", () => {
        // No literals → no `literals` key, so downstream consumers can
        // continue to use the absence as a fast-path check.
        const lines = ["    json={", '        "name": name,', "    },"];
        expect(pyExtractBodyShape(lines, 0)).toEqual({ fields: { name: "name" } });
    });

    test("returns passthrough kwarg for `json=<wrapper>(object_=kwarg, ...)`", () => {
        // The PATCH case: body is the raw kwarg value (a JSON Patch array),
        // not a dict of fields. The shape captures the kwarg name so the
        // body emitter knows to use its value directly.
        const lines = [
            'f"agent/{jsonable_encoder(id)}",',
            '    method="PATCH",',
            "    json=convert_and_respect_annotation_metadata(object_=request, annotation=JsonPatch, direction=\"write\"),",
            "    headers={",
            '        "content-type": "application/json+patch",',
            "    },",
        ];
        expect(pyExtractBodyShape(lines, 0)).toEqual({ passthroughKwarg: "request" });
    });

    test("returns passthrough kwarg for bare `json=<kwarg>`", () => {
        const lines = ['    method="POST",', "    json=body,"];
        expect(pyExtractBodyShape(lines, 0)).toEqual({ passthroughKwarg: "body" });
    });

    test("returns null when no `json=` argument is present", () => {
        const lines = ["    method=\"GET\",", "    request_options=request_options,"];
        expect(pyExtractBodyShape(lines, 0)).toBeNull();
    });
});

describe("pyParseKwargs", () => {
    test("parses simple string/number/bool/null kwargs", () => {
        const src = 'client.foo.bar(name="x", count=3, ok=True, missing=None, flag=False)';
        expect(pyParseKwargs(src)).toEqual([
            { name: "name", value: "x" },
            { name: "count", value: 3 },
            { name: "ok", value: true },
            { name: "missing", value: null },
            { name: "flag", value: false },
        ]);
    });
    test("parses list and dict values, including nested commas", () => {
        const src = 'client.foo.bar(items=[1, 2, 3], meta={"a": 1, "b": [4, 5]})';
        expect(pyParseKwargs(src)).toEqual([
            { name: "items", value: [1, 2, 3] },
            { name: "meta", value: { a: 1, b: [4, 5] } },
        ]);
    });
    test("preserves commas inside string literals", () => {
        const src = 'client.foo.bar(label="a, b, c", count=1)';
        expect(pyParseKwargs(src)).toEqual([
            { name: "label", value: "a, b, c" },
            { name: "count", value: 1 },
        ]);
    });
    test("falls back to <expr:...> for non-literal values", () => {
        const src = "client.foo.bar(when=datetime.now(), id=SomeEnum.A)";
        expect(pyParseKwargs(src)).toEqual([
            { name: "when", value: "<expr:datetime.now()>" },
            { name: "id", value: "<expr:SomeEnum.A>" },
        ]);
    });
    test("rewrites Pydantic-model constructor calls as dict values", () => {
        // Fern's Python wire tests pass model instances by constructor.
        // Without unwrapping, the body falls through to `<expr:...>` and
        // the manifest reports an opaque sentinel instead of the wire shape.
        const src =
            'client.agent.update(id="a", request=[JsonPatchOperation(op="replace", path="/name", value="new")])';
        expect(pyParseKwargs(src)).toEqual([
            { name: "id", value: "a" },
            {
                name: "request",
                value: [{ op: "replace", path: "/name", value: "new" }],
            },
        ]);
    });
    test("recurses into nested constructors", () => {
        const src = 'client.foo.bar(req=Outer(field=Inner(x=1, y="z")))';
        expect(pyParseKwargs(src)).toEqual([
            { name: "req", value: { field: { x: 1, y: "z" } } },
        ]);
    });
    test("rewrites discriminated-union variants (kwargs only, no discriminator field)", () => {
        // The discriminator property name lives in the OpenAPI/Fern schema,
        // not the Python source. Best we can do without schema info is emit
        // the kwargs — incomplete but more useful than `<expr:...>`.
        const src =
            'client.fhir_provider.create(auth=FhirProviderCreateRequestAuth_ClientSecret(client_id="cid", client_secret="cs"))';
        expect(pyParseKwargs(src)).toEqual([
            { name: "auth", value: { client_id: "cid", client_secret: "cs" } },
        ]);
    });
    test("keeps <expr:...> when a constructor uses positional args", () => {
        // Positional args can't be represented as dict entries. Bail at the
        // conversion step so the value falls through to the sentinel rather
        // than producing a misleading partial dict.
        const src = 'client.foo.bar(req=Foo("positional"))';
        expect(pyParseKwargs(src)).toEqual([
            { name: "req", value: '<expr:Foo("positional")>' },
        ]);
    });
    test("converts constructor literals (True/False/None) inside args", () => {
        const src = 'client.foo.bar(req=Foo(active=True, deleted=False, ts=None, n=2))';
        expect(pyParseKwargs(src)).toEqual([
            { name: "req", value: { active: true, deleted: false, ts: null, n: 2 } },
        ]);
    });
    test("returns empty list for a call with no args", () => {
        expect(pyParseKwargs("client.foo.bar()")).toEqual([]);
    });
    test("handles multi-line kwargs (Fern's default formatting)", () => {
        const src = [
            "client.agent.create(",
            '    name="name",',
            '    prompts=["a", "b"],',
            '    provider="provider",',
            ")",
        ].join("\n");
        expect(pyParseKwargs(src)).toEqual([
            { name: "name", value: "name" },
            { name: "prompts", value: ["a", "b"] },
            { name: "provider", value: "provider" },
        ]);
    });
    test("accepts trailing commas in list and dict values (Black formatting)", () => {
        // Black formats multi-line collections with trailing commas. The
        // values are valid Python but rejected by JSON.parse — must be
        // stripped before parsing or they fall through to <expr:...>.
        const src = [
            "client.foo.bar(",
            "    items=[",
            '        "a",',
            '        "b",',
            "    ],",
            "    meta={",
            '        "x": 1,',
            '        "y": 2,',
            "    },",
            ")",
        ].join("\n");
        expect(pyParseKwargs(src)).toEqual([
            { name: "items", value: ["a", "b"] },
            { name: "meta", value: { x: 1, y: 2 } },
        ]);
    });
    test("preserves trailing-comma-like sequences inside string literals", () => {
        // A literal `,]` inside a quoted value must not be elided.
        const src = 'client.foo.bar(label="a,]b")';
        expect(pyParseKwargs(src)).toEqual([{ name: "label", value: "a,]b" }]);
    });
});

describe("deriveBodyFromKwargs", () => {
    function endpoint(
        over: Partial<{
            httpMethod: string;
            httpPath: string;
            bodyParamMap?: Record<string, string>;
            bodyLiterals?: Record<string, unknown>;
            bodyPassthroughKwarg?: string;
        }>,
    ) {
        return {
            httpMethod: "POST",
            httpPath: "/foo",
            methodChain: ["foo"],
            methodName: "foo",
            ...over,
        };
    }

    test("returns null for methods without bodies", () => {
        const args = [{ name: "id", value: "x" }];
        expect(deriveBodyFromKwargs(endpoint({ httpMethod: "GET", httpPath: "/agent/{id}" }), args)).toBeNull();
        expect(deriveBodyFromKwargs(endpoint({ httpMethod: "DELETE", httpPath: "/agent/{id}" }), args)).toBeNull();
    });
    test("uses bodyParamMap as an allowlist, excluding headers/query/path kwargs", () => {
        // Mirrors the streaming-endpoint shape: a POST with body kwargs
        // (`message`, `agent_id`) plus a header kwarg (`phenoml_on_behalf_of`).
        // Only the body kwargs must end up in `request.body`.
        const args = [
            { name: "phenoml_on_behalf_of", value: "user@example.com" },
            { name: "message", value: "hi" },
            { name: "agent_id", value: "agent-123" },
        ];
        const result = deriveBodyFromKwargs(
            endpoint({
                httpPath: "/agent/stream-chat",
                bodyParamMap: { message: "message", agent_id: "agent_id" },
            }),
            args,
        );
        expect(result).toEqual({ message: "hi", agent_id: "agent-123" });
    });
    test("emits aliased JSON field names from bodyParamMap rather than kwarg names", () => {
        // The reviewer's case: Fern maps `some_field` (kwarg) → `someField`
        // (wire field). The body must use the wire key — that's what the
        // SDK actually sends over HTTP and what the manifest documents.
        const args = [{ name: "some_field", value: "v" }];
        const result = deriveBodyFromKwargs(
            endpoint({ bodyParamMap: { some_field: "someField" } }),
            args,
        );
        expect(result).toEqual({ someField: "v" });
    });
    test("returns null when bodyParamMap is empty (no `json={...}` body)", () => {
        const args = [{ name: "id", value: "x" }];
        expect(deriveBodyFromKwargs(endpoint({ bodyParamMap: {} }), args)).toBeNull();
    });
    test("falls back to path-param exclusion when bodyParamMap is undefined", () => {
        // Used for endpoints whose raw client doesn't have a `json={...}`
        // dict literal (rare in practice). Still leaks header/query kwargs
        // and can't honor field-name aliases — better than emitting null.
        const args = [
            { name: "id", value: "agent-123" },
            { name: "name", value: "new-name" },
            { name: "metadata", value: { key: "v" } },
        ];
        expect(deriveBodyFromKwargs(endpoint({ httpMethod: "PATCH", httpPath: "/agent/{id}" }), args)).toEqual({
            name: "new-name",
            metadata: { key: "v" },
        });
    });
    test("returns null when every kwarg is a path param (fallback path)", () => {
        const args = [{ name: "id", value: "x" }];
        expect(deriveBodyFromKwargs(endpoint({ httpPath: "/agent/{id}/touch" }), args)).toBeNull();
    });
    test("ignores positional-style args (TS shape) — they aren't kwargs", () => {
        // TS parser emits plain values, not {name, value}. The kwarg-style
        // derivation must skip them so it doesn't misclassify TS bodies.
        const args = [{ some: "object", literal: true }];
        expect(deriveBodyFromKwargs(endpoint({}), args)).toBeNull();
    });
    test("returns the passthrough kwarg's value directly as the body", () => {
        // The PATCH case: `json=convert_and_respect_annotation_metadata(object_=request, ...)`.
        // The body IS the JSON Patch array, not `{"request": [...]}`.
        const args = [
            { name: "id", value: "agent-123" },
            { name: "request", value: [{ op: "replace", path: "/name", value: "new" }] },
        ];
        expect(
            deriveBodyFromKwargs(
                endpoint({ httpMethod: "PATCH", httpPath: "/agent/{id}", bodyPassthroughKwarg: "request" }),
                args,
            ),
        ).toEqual([{ op: "replace", path: "/name", value: "new" }]);
    });
    test("returns null when passthrough kwarg is missing and only path-param kwargs remain", () => {
        // The passthrough kwarg isn't in the call args, so we fall through
        // to the kwarg heuristic — which itself returns null when the only
        // remaining kwarg is a path param.
        const args = [{ name: "id", value: "agent-123" }];
        expect(
            deriveBodyFromKwargs(
                endpoint({ httpMethod: "PATCH", httpPath: "/agent/{id}", bodyPassthroughKwarg: "request" }),
                args,
            ),
        ).toBeNull();
    });
    test("falls back to the kwarg heuristic when passthrough kwarg names an intermediate variable", () => {
        // If a raw client builds `body = {...}` then does `json=body`, the
        // parser marks `body` as the passthrough kwarg — but the test
        // supplies the original SDK kwargs, not `body`. We must fall through
        // to the path-param-exclusion heuristic so the body isn't dropped.
        const args = [
            { name: "name", value: "x" },
            { name: "count", value: 3 },
        ];
        const result = deriveBodyFromKwargs(
            endpoint({ httpMethod: "POST", httpPath: "/foo", bodyPassthroughKwarg: "body" }),
            args,
        );
        expect(result).toEqual({ name: "x", count: 3 });
    });
    test("merges bodyLiterals into the fallback body when passthrough kwarg is absent", () => {
        // The passthrough kwarg isn't in the args, so we fall through —
        // but any captured literals from a `json={...}` shape should still
        // be merged. (In practice a single endpoint won't have both
        // passthrough and literals, but the fallback should remain
        // self-consistent.)
        const args = [{ name: "name", value: "x" }];
        const result = deriveBodyFromKwargs(
            endpoint({
                httpMethod: "POST",
                httpPath: "/foo",
                bodyPassthroughKwarg: "body",
                bodyLiterals: { kind: "literal" },
            }),
            args,
        );
        expect(result).toEqual({ kind: "literal", name: "x" });
    });
    test("merges bodyLiterals into the derived body alongside kwarg fields", () => {
        // The FHIR bundle case: `resourceType: "Bundle"` is a literal in
        // the raw client's `json={...}` dict. The manifest body must
        // include it so consumers replaying the example send a valid
        // FHIR Bundle (which requires resourceType).
        const args = [
            { name: "fhir_provider_id", value: "provider-id" },
            { name: "entry", value: [{ resource: { resourceType: "Patient" } }] },
            { name: "total", value: 1 },
        ];
        expect(
            deriveBodyFromKwargs(
                endpoint({
                    httpPath: "/fhir-provider/{fhir_provider_id}/fhir",
                    bodyParamMap: { entry: "entry", total: "total" },
                    bodyLiterals: { resourceType: "Bundle" },
                }),
                args,
            ),
        ).toEqual({
            resourceType: "Bundle",
            entry: [{ resource: { resourceType: "Patient" } }],
            total: 1,
        });
    });
    test("returns literals-only body when no kwargs supply field values", () => {
        // Tests that omit kwargs still produce a body documenting the
        // SDK's fixed literal fields rather than null.
        expect(
            deriveBodyFromKwargs(
                endpoint({
                    bodyParamMap: { entry: "entry" },
                    bodyLiterals: { resourceType: "Bundle" },
                }),
                [],
            ),
        ).toEqual({ resourceType: "Bundle" });
    });
});

// ============================================================
// End-to-end parser tests against real SDK fixtures
// ============================================================

describe("TypeScript parser (Summary client fixture)", () => {
    const root = path.join(FIXTURES, "typescript");
    const parser = createTypeScriptParser();
    const endpoints = parser.parseEndpoints(root);
    const examples = parser.parseTestExamples(root);

    test("parseEndpoints extracts all 6 Summary endpoints plus the agent streaming/chat/get endpoints", () => {
        const keys = endpoints.map((e) => `${e.httpMethod} ${e.httpPath}`).sort();
        expect(keys).toEqual([
            "DELETE /fhir2summary/template/{id}",
            "GET /agent/{agent_id}",
            "GET /fhir2summary/template/{id}",
            "GET /fhir2summary/templates",
            "POST /agent/chat",
            "POST /agent/stream-chat",
            "POST /fhir2summary/create",
            "POST /fhir2summary/template",
            "PUT /fhir2summary/template/{id}",
        ]);
    });

    test("parseEndpoints derives sdkMethodChain from the file path", () => {
        const listTemplates = endpoints.find((e) => e.methodName === "listTemplates");
        expect(listTemplates?.methodChain).toEqual(["summary", "listTemplates"]);
    });

    test("parseTestExamples extracts only (1) variants of each test", () => {
        // The Summary fixture has 6 methods + the agent streamChat fixture,
        // each with several numbered variants ((1) success, (2)/(3) error
        // cases). Only the (1) success cases should be extracted.
        expect(examples).toHaveLength(7);
        expect(examples.every((e) => e.httpMethod && e.httpPath)).toBe(true);
    });

    test("parseTestExamples populates requestBody from rawRequestBody literal", () => {
        // The TS parser reads a `const rawRequestBody = {...}` literal from
        // the wire test directly. createTemplate's (1) variant assigns one,
        // so requestBody must be the parsed object (not null).
        const createTemplate = examples.find((e) => e.httpMethod === "POST" && e.httpPath === "/fhir2summary/template");
        expect(createTemplate).toBeDefined();
        expect(createTemplate!.requestBody).toEqual({
            name: "name",
            example_summary: "Patient John Doe, age 45, presents with hypertension diagnosed on 2024-01-15.",
            target_resources: ["Patient", "Condition", "Observation"],
            mode: "mode",
        });
        // The SDK call's single object arg also flows into sdkCallArgs.
        expect(createTemplate!.sdkCallArgs).toHaveLength(1);
    });

    test("parseEndpoints flags methods returning `core.Stream<...>` as streaming", () => {
        const streamChat = endpoints.find((e) => e.methodName === "streamChat");
        expect(streamChat?.isStreaming).toBe(true);
    });

    test("parseEndpoints leaves non-streaming endpoints' isStreaming undefined", () => {
        const createTemplate = endpoints.find((e) => e.methodName === "createTemplate");
        expect(createTemplate?.isStreaming).toBeUndefined();
    });

    test("buildManifest replaces an SSE endpoint's mock body with `{ body: null, streaming: true }`", () => {
        // Wire tests for SSE endpoints use `.sseBody("event: ...\ndata: ...\n\n")`
        // which would otherwise leak the raw wire string into `response.body`.
        // With isStreaming set, manifest.ts drops the placeholder.
        const metadata = {
            generatorName: "fernapi/fern-typescript-sdk",
            sdkVersion: "0.0.0",
            originGitCommit: "deadbeef",
        };
        const manifest = buildManifest(endpoints, examples, "typescript", "pkg", metadata);
        expect(manifest.examples["POST /agent/stream-chat"].response).toEqual({
            body: null,
            streaming: true,
        });
    });

    test("renderSchema reads the request interface and filters destructured header keys", () => {
        // `chat` has `const { "X-Phenoml-On-Behalf-Of": ..., ..._body } = request`
        // so the header key must be absent from body.fields, leaving just
        // the wire body properties.
        const chat = endpoints.find((e) => e.methodName === "chat")!;
        expect(chat.renderSchema?.callTemplate).toBe("client.agent.chat({ {{__body__}} })");
        const fields = chat.renderSchema?.body?.fields ?? [];
        expect(fields.map((f) => f.jsonKey)).toEqual(["message", "role", "tools", "categories"]);
        expect(fields.find((f) => f.jsonKey === "X-Phenoml-On-Behalf-Of")).toBeUndefined();
    });

    test("renderSchema recurses into list-of-object items via items.nested", () => {
        // `categories?: Tag[]` should expose the Tag interface's fields
        // (name, color) under items.nested so consumers can add/edit
        // properties inside list elements.
        const chat = endpoints.find((e) => e.methodName === "chat")!;
        const categories = chat.renderSchema?.body?.fields.find((f) => f.jsonKey === "categories");
        expect(categories?.kind).toBe("list");
        expect(categories?.items?.kind).toBe("object");
        const nestedKeys = categories?.items?.nested?.fields.map((f) => f.jsonKey) ?? [];
        expect(nestedKeys).toEqual(["name", "color"]);
        // The nested schema must carry the TS object-literal envelope.
        // Without it, the consumer's renderer would join the property
        // chain bare and emit `[name: "x", color: "red"]` instead of
        // `[{ name: "x", color: "red" }]`.
        expect(categories?.items?.nested?.wrap).toBe("{ {{__body__}} }");
    });

    test("renderSchema exposes namespace-const enums via enumValues", () => {
        // `role?: AgentChatRequest.Role` resolves to the sibling namespace's
        // `const Role = { Assistant: "assistant", ... } as const`. The wire
        // values feed UI dropdowns; the namespace-qualified expressions
        // (`AgentChatRequest.Role.Assistant`) feed renderers — without them,
        // a `.role("assistant")` render wouldn't satisfy the property's
        // namespace-typed signature.
        const chat = endpoints.find((e) => e.methodName === "chat")!;
        const role = chat.renderSchema?.body?.fields.find((f) => f.jsonKey === "role");
        expect(role?.kind).toBe("enum");
        expect(role?.enumValues).toEqual(["assistant", "reviewer"]);
        expect(role?.enumConstants).toEqual({
            "assistant": "AgentChatRequest.Role.Assistant",
            "reviewer": "AgentChatRequest.Role.Reviewer",
        });
    });

    test("renderSchema recognizes list types and recurses into items", () => {
        const chat = endpoints.find((e) => e.methodName === "chat")!;
        const tools = chat.renderSchema?.body?.fields.find((f) => f.jsonKey === "tools");
        expect(tools?.kind).toBe("list");
        expect(tools?.items?.kind).toBe("string");
    });

    test("renderSchema handles positional path params before the request object", () => {
        // Fern emits `getAgent(agentId: string, request: SomeRequest)` for
        // endpoints with URL templates. The path param goes into `params[]`
        // (snake_cased to match URL templates), the request type still
        // resolves and feeds body.fields. Earlier versions of the extractor
        // grabbed `agentId: string` as the request type and emitted an empty
        // body — this guards against that regression.
        const getAgent = endpoints.find((e) => e.methodName === "getAgent")!;
        expect(getAgent.renderSchema?.callTemplate).toBe(
            "client.agent.getAgent({{agent_id}}, { {{__body__}} })",
        );
        expect(getAgent.renderSchema?.params).toEqual([
            { name: "agent_id", kind: "string" },
        ]);
        const fields = getAgent.renderSchema?.body?.fields ?? [];
        expect(fields.map((f) => f.jsonKey)).toEqual(["version"]);
    });

    test("renderSchema does NOT treat `const { x } = request` as a header destructure when no rest binding is present", () => {
        // `__getAgent` does `const { version } = request;` to extract a
        // query param — without a `..._body` rest binding. The destructure
        // detector must require the rest binding to flag keys as headers,
        // otherwise `version` would vanish from body.fields.
        const getAgent = endpoints.find((e) => e.methodName === "getAgent")!;
        const fields = getAgent.renderSchema?.body?.fields ?? [];
        expect(fields.find((f) => f.jsonKey === "version")).toBeDefined();
    });

    test("renderSchema keeps body-shaped header keys when the method skips destructuring", () => {
        // `streamChat` ships `body: request` whole, so even the X-header
        // field stays in body.fields. (The wire payload still has it; the
        // SDK just leaves header forwarding to the test harness.)
        const stream = endpoints.find((e) => e.methodName === "streamChat")!;
        const keys = stream.renderSchema?.body?.fields.map((f) => f.jsonKey) ?? [];
        expect(keys).toContain("X-Phenoml-On-Behalf-Of");
        expect(keys).toContain("message");
    });
});

describe("typescript-schema helpers", () => {
    const enums = new Map<string, string[]>([["Role", ["assistant", "reviewer"]]]);

    test("tsInferKind classifies the shapes Fern emits", () => {
        expect(tsInferKind("string", enums)).toBe("string");
        expect(tsInferKind("number", enums)).toBe("number");
        expect(tsInferKind("boolean", enums)).toBe("boolean");
        expect(tsInferKind("string[]", enums)).toBe("list");
        expect(tsInferKind("ReadonlyArray<number>", enums)).toBe("list");
        expect(tsInferKind("Foo.Role", enums)).toBe("enum");
        expect(tsInferKind("SomeOtherType", enums)).toBe("object");
    });

    test("tsExtractMethodSignatureInfo returns the request type name + destructured header keys", () => {
        const clientFile = path.join(FIXTURES, "typescript", "src", "api", "resources", "agent", "client", "Client.ts");
        const info = tsExtractMethodSignatureInfo(clientFile, "chat");
        expect(info?.requestTypeName).toBe("AgentChatRequest");
        expect(info?.headerKeys.has("X-Phenoml-On-Behalf-Of")).toBe(true);
    });

    test("tsResolveRequestInterfacePath looks under the client's sibling requests/ dir", () => {
        const clientFile = path.join(FIXTURES, "typescript", "src", "api", "resources", "agent", "client", "Client.ts");
        const interfaceFile = tsResolveRequestInterfacePath(clientFile, "AgentChatRequest");
        expect(interfaceFile).toBeTruthy();
        expect(interfaceFile!.endsWith("AgentChatRequest.ts")).toBe(true);
    });

    test("tsParseRequestInterface extracts fields + namespace-const enums", () => {
        const clientFile = path.join(FIXTURES, "typescript", "src", "api", "resources", "agent", "client", "Client.ts");
        const interfaceFile = tsResolveRequestInterfacePath(clientFile, "AgentChatRequest")!;
        const info = tsParseRequestInterface(interfaceFile);
        expect(info?.interfaceName).toBe("AgentChatRequest");
        expect(info?.fields.map((f) => f.jsonKey)).toEqual([
            "X-Phenoml-On-Behalf-Of",
            "message",
            "role",
            "tools",
            "categories",
        ]);
        expect(info?.fields.find((f) => f.jsonKey === "message")?.isOptional).toBe(false);
        expect(info?.fields.find((f) => f.jsonKey === "role")?.isOptional).toBe(true);
        expect(info?.enums.get("Role")).toEqual([
            { key: "Assistant", wireValue: "assistant" },
            { key: "Reviewer", wireValue: "reviewer" },
        ]);
    });
});

describe("Python parser (Authtoken auth fixture)", () => {
    const root = path.join(FIXTURES, "python");
    const parser = createPythonParser();
    const endpoints = parser.parseEndpoints(root);
    const examples = parser.parseTestExamples(root);

    test("parseEndpoints extracts get_token", () => {
        const getToken = endpoints.find((e) => e.methodName === "get_token");
        expect(getToken).toMatchObject({
            httpMethod: "POST",
            httpPath: "/v2/auth/token",
            methodChain: ["authtoken", "auth", "get_token"],
        });
    });

    test("parseEndpoints snake_cases camelCase path parameters", () => {
        // The synthetic users/raw_client.py uses f"users/{jsonable_encoder(userId)}".
        // Without normalizePathParams the manifest key would be /users/{userId},
        // diverging from the TS/Java parsers which always emit snake_case.
        const getUser = endpoints.find((e) => e.methodName === "get_user");
        expect(getUser).toMatchObject({
            httpMethod: "GET",
            httpPath: "/users/{user_id}",
        });
    });

    test("parseTestExamples extracts the wire test and looks up the WireMock response", () => {
        // Fixture has two test files (test_authtoken_auth.py + test_long_body.py),
        // both targeting POST /v2/auth/token.
        expect(examples.length).toBeGreaterThanOrEqual(1);
        const example = examples.find((e) => e.httpMethod === "POST" && e.httpPath === "/v2/auth/token");
        expect(example).toBeDefined();
        // Response body was populated from wiremock/wiremock-mappings.json
        expect(example!.responseBody).toEqual({
            access_token: "test-token",
            expires_in: 3600,
        });
    });

    test("parseTestExamples scans past 60 lines of test body", () => {
        // The test_long_body fixture places its SDK call + verify_request_count
        // at ~line 78. An earlier 60-line cap would silently drop this entry.
        const longBody = examples.find(
            (e) => e.httpMethod === "POST" && e.httpPath === "/v2/auth/token" && e.sdkCallSource.includes("client.authtoken.auth.get_token"),
        );
        expect(longBody).toBeDefined();
        // Every fixture targeting /v2/auth/token should yield an example:
        // test_authtoken_auth.py, test_long_body.py, and the two wrapped
        // tests in test_multiline_verify.py (no truncation drops any).
        expect(examples.filter((e) => e.httpPath === "/v2/auth/token").length).toBe(4);
    });

    test("parseTestExamples handles multi-line verify_request_count calls", () => {
        // Black wraps long calls across multiple lines; the single-line
        // regex used to drop both wrapped forms. Confirm both shapes from
        // test_multiline_verify.py are extracted with the correct method
        // and path.
        const wrappedA = examples.find((e) => e.methodName === "auth_get_token_wrapped_inline");
        const wrappedB = examples.find((e) => e.methodName === "auth_get_token_wrapped_per_arg");
        expect(wrappedA).toMatchObject({ httpMethod: "POST", httpPath: "/v2/auth/token" });
        expect(wrappedB).toMatchObject({ httpMethod: "POST", httpPath: "/v2/auth/token" });
    });

    test("parseTestExamples strips the `for _ in ...:` wrapper from streaming tests", () => {
        // Fern's Python generator wraps streaming calls in
        // `for _ in client.foo(...): pass`. The captured sdkCallSource must
        // be just the call expression — no `for` prefix, no trailing `:`.
        const stream = examples.find((e) => e.sdkCallSource.includes("stream_chat"));
        expect(stream).toBeDefined();
        expect(stream!.sdkCallSource.startsWith("client.agent.stream_chat(")).toBe(true);
        expect(stream!.sdkCallSource.endsWith(")")).toBe(true);
        expect(stream!.sdkCallSource).not.toContain("for _ in");
        expect(stream!.sdkCallSource).not.toContain("):");
    });

    test("parseTestExamples populates sdkCallArgs from the SDK call kwargs", () => {
        // The auth fixture's get_token call passes three kwargs; they
        // must round-trip into sdkCallArgs as {name, value} pairs.
        const withArgs = examples.find((e) => e.sdkCallArgs.length > 0 && e.httpPath === "/v2/auth/token");
        expect(withArgs).toBeDefined();
        expect(withArgs!.sdkCallArgs).toEqual([
            { name: "grant_type", value: "client_credentials" },
            { name: "client_id", value: "my-client" },
            { name: "client_secret", value: "my-secret" },
        ]);
    });

    test("buildManifest derives request.body from kwargs for POST endpoints", () => {
        // End-to-end: the Python parser doesn't capture body literals from
        // tests, so buildManifest must derive `body` from sdkCallArgs.
        // Both test_authtoken_auth.py (kwargs) and test_long_body.py (no
        // kwargs) target /v2/auth/token; buildManifest's richness check
        // must keep the kwarg-bearing one regardless of file order.
        const metadata = {
            generatorName: "fernapi/fern-python-sdk",
            sdkVersion: "0.0.0",
            originGitCommit: "deadbeef",
        };
        const manifest = buildManifest(endpoints, examples, "python", "pkg", metadata);
        const entry = manifest.examples["POST /v2/auth/token"];
        expect(entry).toBeDefined();
        expect(entry.request.body).toEqual({
            grant_type: "client_credentials",
            client_id: "my-client",
            client_secret: "my-secret",
        });
    });

    test("renderSchema emits an all-kwarg call template plus a typed BodySchema", () => {
        // Python Fern signatures are all-kwarg; the consumer renders every
        // input (including path params) as a kwarg, so callTemplate has no
        // {{name}} placeholders and `params` is always empty.
        const getToken = endpoints.find((e) => e.methodName === "get_token")!;
        expect(getToken.renderSchema?.callTemplate).toBe("client.authtoken.auth.get_token({{__body__}})");
        expect(getToken.renderSchema?.params).toEqual([]);
        const fields = getToken.renderSchema?.body?.fields ?? [];
        expect(fields.map((f) => f.jsonKey)).toEqual(["grant_type", "client_id", "client_secret"]);
        for (const f of fields) {
            expect(f.fieldTemplate).toBe(`${f.jsonKey}={{value}}`);
            expect(f.required).toBe(false);
        }
    });

    test("renderSchema treats path-param kwargs like body fields", () => {
        // users.get_user takes `user_id` as a positional-or-kwarg arg with
        // no default. The wire body is empty but the consumer still needs
        // to render `user_id="..."` — putting it in body.fields matches
        // Python's call shape.
        const getUser = endpoints.find((e) => e.methodName === "get_user")!;
        const fields = getUser.renderSchema?.body?.fields ?? [];
        expect(fields.length).toBe(1);
        expect(fields[0]).toMatchObject({
            jsonKey: "user_id",
            fieldTemplate: "user_id={{value}}",
            kind: "string",
            required: true,
        });
    });
});

describe("python-schema helpers", () => {
    test("pyInferKind recognizes the type shapes Fern emits", () => {
        expect(pyInferKind("str")).toBe("string");
        expect(pyInferKind("typing.Optional[str]")).toBe("string");
        expect(pyInferKind("int")).toBe("number");
        expect(pyInferKind("bool")).toBe("boolean");
        expect(pyInferKind("typing.Sequence[str]")).toBe("list");
        expect(pyInferKind("typing.Optional[typing.Sequence[str]]")).toBe("list");
        // Fern enum shape: Union[Literal["a","b"], Any]
        expect(pyInferKind('typing.Union[typing.Literal["a", "b"], typing.Any]')).toBe("enum");
    });

    test("pyStripOptional unwraps a single Optional layer", () => {
        expect(pyStripOptional("typing.Optional[str]")).toBe("str");
        expect(pyStripOptional("Optional[List[int]]")).toBe("List[int]");
        expect(pyStripOptional("str")).toBe("str");
    });

    test("pyUnwrapList returns the inner type or 'object' as a fallback", () => {
        expect(pyUnwrapList("typing.Sequence[str]")).toBe("str");
        expect(pyUnwrapList("typing.Optional[typing.List[int]]")).toBe("int");
        expect(pyUnwrapList("str")).toBe("object");
    });

    test("pyExtractEnumValues pulls out Literal values", () => {
        const t = 'typing.Union[typing.Literal["x", "y", "z"], typing.Any]';
        expect(pyExtractEnumValues(t)).toEqual(["x", "y", "z"]);
    });

    test("pyExtractMethodKwargs reads kwargs with their type annotations", () => {
        const filePath = path.join(FIXTURES, "python", "src", "phenoml", "authtoken", "auth", "raw_client.py");
        const kwargs = pyExtractMethodKwargs(filePath, "get_token");
        expect(kwargs.map((k) => k.name)).toEqual(["grant_type", "client_id", "client_secret"]);
        for (const kw of kwargs) {
            expect(kw.typeAnnotation).toBe("typing.Optional[str]");
            expect(kw.hasDefault).toBe(true);
        }
    });

    test("pyExtractHeaderKwargs is empty when the method has no header kwargs", () => {
        // The fixture's get_token doesn't push any kwargs into headers.
        const filePath = path.join(FIXTURES, "python", "src", "phenoml", "authtoken", "auth", "raw_client.py");
        const headers = pyExtractHeaderKwargs(filePath, "get_token");
        // Don't strictly assert size — just that nothing kwarg-shaped leaked.
        expect(headers.has("grant_type")).toBe(false);
        expect(headers.has("client_id")).toBe(false);
        expect(headers.has("client_secret")).toBe(false);
    });
});

describe("Java parser (AuthtokenAuth fixture)", () => {
    const root = path.join(FIXTURES, "java");
    const parser = createJavaParser();
    const endpoints = parser.parseEndpoints(root);
    const examples = parser.parseTestExamples(root);

    test("parseEndpoints extracts both overloads of generateToken", () => {
        // The fixture defines two methods that return PhenomlClientHttpResponse:
        //   generateToken(...) and getToken(...)
        expect(endpoints.length).toBeGreaterThanOrEqual(1);
        const generateToken = endpoints.find((e) => e.methodName === "generateToken");
        expect(generateToken).toMatchObject({
            httpMethod: "POST",
            httpPath: "/auth/token",
            methodChain: ["authtoken", "auth", "generateToken"],
        });
    });

    test("parseTestExamples parses request/response bodies from the wire test", () => {
        expect(examples).toHaveLength(1);
        const ex = examples[0];
        expect(ex.httpMethod).toBe("POST");
        expect(ex.methodName).toBe("generateToken");
        expect(ex.requestBody).toEqual({ username: "username", password: "password" });
        expect(ex.responseBody).toEqual({ token: "token" });
        // SDK call source is preserved with chained calls
        expect(ex.sdkCallSource).toContain("client.authtoken()");
        expect(ex.sdkCallSource).toContain(".generateToken(");
    });

    test("parseEndpoints captures the request class name from the method signature", () => {
        // generateToken(AuthGenerateTokenRequest request, RequestOptions requestOptions)
        // → javaRequestClass="AuthGenerateTokenRequest". Drives phase 2b's
        //   request-class file discovery.
        const generateToken = endpoints.find((e) => e.methodName === "generateToken");
        expect(generateToken?.javaRequestClass).toBe("AuthGenerateTokenRequest");
        // Whole-object body (writeValueAsBytes), no explicit properties.put.
        expect(generateToken?.javaBodyJsonKeys).toBeUndefined();
        // No request-derived headers in the fixture.
        expect(generateToken?.javaHeaderJsonKeys).toBeUndefined();
        expect(generateToken?.javaPositionalParams).toBeUndefined();
    });
});

describe("Java parser (accessor-map fixture)", () => {
    const root = path.join(FIXTURES, "java-accessor");
    const parser = createJavaParser();
    const endpoints = parser.parseEndpoints(root);
    const examples = parser.parseTestExamples(root);

    test("emits camelCase accessor names in sdkMethodChain instead of lowercased dir names", () => {
        const create = endpoints.find((e) => e.methodName === "create" && e.httpPath === "/fhir-provider");
        expect(create).toBeDefined();
        expect(create!.methodChain).toEqual(["fhirProvider", "create"]);
    });

    test("emits camelCase accessor names for nested resources", () => {
        const create = endpoints.find((e) => e.methodName === "create" && e.httpPath === "/tools/mcp-server");
        expect(create).toBeDefined();
        expect(create!.methodChain).toEqual(["tools", "mcpServer", "create"]);
    });

    test("loads TestResources.loadResource() fixture contents into the response body", () => {
        const ex = examples.find((e) => e.methodName === "create");
        expect(ex).toBeDefined();
        expect(ex!.responseBody).toMatchObject({
            success: true,
            message: "Fhir provider created successfully",
        });
    });
});

describe("Java parser (streaming-endpoint fixture)", () => {
    const root = path.join(FIXTURES, "java-stream");
    const endpoints = createJavaParser().parseEndpoints(root);

    test("captures the path even when a later `client.newBuilder()` follows the URL builder", () => {
        // `client.newBuilder().callTimeout(...).build()` appears after the
        // URL builder in streaming endpoints; the path capture must survive it.
        const streamChat = endpoints.find((e) => e.methodName === "streamChat");
        expect(streamChat).toMatchObject({
            httpMethod: "POST",
            httpPath: "/agent/stream-chat",
            methodChain: ["agent", "streamChat"],
        });
    });

    test("flags methods returning `Iterable<...>` as streaming so the manifest doesn't surface the mock placeholder body", () => {
        const streamChat = endpoints.find((e) => e.methodName === "streamChat");
        expect(streamChat?.isStreaming).toBe(true);
    });
});

describe("Java parser (deeply-nested builder fixture)", () => {
    const root = path.join(FIXTURES, "java-deep-builder");
    const examples = createJavaParser().parseTestExamples(root);

    test("captures the entire SDK call expression even when it spans 40+ lines", () => {
        // `.phenomlOnBehalfOf(` sits ~43 lines into the call, past the old cap.
        expect(examples).toHaveLength(1);
        const ex = examples[0];
        expect(ex.sdkCallSource).toContain("client.fhir()");
        expect(ex.sdkCallSource).toContain(".executeBundle(");
        expect(ex.sdkCallSource).toContain(".phenomlOnBehalfOf(");
        expect(isBalancedParens(ex.sdkCallSource)).toBe(true);
        expect(ex.sdkCallSource.trimEnd().endsWith(")")).toBe(true);
    });
});

describe("Java parser (multi-line signature fixture)", () => {
    const root = path.join(FIXTURES, "java-multiline");
    const endpoints = createJavaParser().parseEndpoints(root);

    test("exits at the actual closing brace so helpers don't corrupt collected state", () => {
        // Both API methods use path "/things". A broken method-exit would let
        // the intermediate private helper's "PUT /wrong/path" overwrite
        // getThing's state, causing the manifest to attribute "PUT /wrong/path"
        // to getThing instead of "GET /things".
        const getThing = endpoints.find((e) => e.methodName === "getThing");
        const postThing = endpoints.find((e) => e.methodName === "postThing");
        expect(getThing).toMatchObject({ httpMethod: "GET", httpPath: "/things" });
        expect(postThing).toMatchObject({ httpMethod: "POST", httpPath: "/things" });
        // The helper's "PUT /wrong/path" must never appear.
        expect(endpoints.some((e) => e.httpPath === "/wrong/path")).toBe(false);
        expect(endpoints.some((e) => e.httpMethod === "PUT")).toBe(false);
    });

    test("extracts methods whose signature spans 3+ lines (one param per line)", () => {
        // Parameter-only lines sit at the class-body brace depth — a naive
        // exit check that fires whenever braceDepth dips to/below the
        // method's level would drop the endpoint before its body is scanned.
        const getThingById = endpoints.find((e) => e.methodName === "getThingById");
        expect(getThingById).toMatchObject({
            httpMethod: "GET",
            httpPath: "/things/{codesystem}/{code_id}",
        });
    });
});

// ============================================================
// Java request-class parser (small helper tests)
// ============================================================

describe("parseJavaFieldDeclarations", () => {
    test("extracts only outer-class fields, not nested-class fields", () => {
        // Fern request classes nest union/builder inner classes that also
        // declare `private final` fields. A naive scan would mix them into
        // the outer schema; the scoping fix bounds collection to depth 1.
        const source = `
            public final class Outer {
                private final String text;
                private final Optional<List<String>> tags;
                private final Map<String, Object> additionalProperties;
                public static final class Inner {
                    private final Object value;
                    private final int type;
                }
            }
        `;
        const fields = parseJavaFieldDeclarations(source);
        expect(fields.map((f) => f.fieldName)).toEqual(["text", "tags"]);
        expect(fields[1].isOptional).toBe(true);
        expect(fields[1].innerType).toBe("List<String>");
    });
});

describe("parseJavaJsonProperties", () => {
    test("maps Fern getter names back to wire keys", () => {
        const source = `
            @JsonProperty("X-Phenoml-On-Behalf-Of")
            public Optional<String> getPhenomlOnBehalfOf() { return phenomlOnBehalfOf; }
            @JsonProperty("provider")
            public String getProvider() { return provider; }
        `;
        const map = parseJavaJsonProperties(source);
        expect(map.get("phenomlOnBehalfOf")).toBe("X-Phenoml-On-Behalf-Of");
        expect(map.get("provider")).toBe("provider");
    });
});

describe("parseJavaJsonIgnoredFields", () => {
    test("flags @JsonIgnore'd getters so the schema excludes them", () => {
        const source = `
            @JsonIgnore
            public Optional<String> getPhenomlOnBehalfOf() { return phenomlOnBehalfOf; }
            @JsonProperty("text")
            public String getText() { return text; }
        `;
        const ignored = parseJavaJsonIgnoredFields(source);
        expect(ignored.has("phenomlOnBehalfOf")).toBe(true);
        expect(ignored.has("text")).toBe(false);
    });
});

describe("parseJavaStagedBuilderOrder", () => {
    test("recovers required-field order from staged-builder interfaces", () => {
        // Each non-_FinalStage interface has exactly one setter whose name is
        // the field. Order across interfaces is the required-field order.
        const source = `
            public interface TextStage { ProviderStage text(@NotNull String text); Builder from(X other); }
            public interface ProviderStage { _FinalStage provider(@NotNull String provider); }
            public interface _FinalStage {
                X build();
                _FinalStage scope(Optional<String> scope);
            }
        `;
        expect(parseJavaStagedBuilderOrder(source)).toEqual(["text", "provider"]);
    });
});

describe("parseJavaEnumValues", () => {
    test("captures constant-name / wire-value pairs from Fern enum constructors", () => {
        // Both halves are needed: the wire value (`assistant`) matches the
        // serialized request body, the constant name (`ASSISTANT`) is what a
        // Java renderer must type into the SDK call as `AgentRole.ASSISTANT`.
        const source = `
            public enum AgentRole {
                ASSISTANT("assistant"),
                REVIEWER("reviewer");
                private final String value;
                AgentRole(String value) { this.value = value; }
            }
        `;
        expect(parseJavaEnumValues(source)).toEqual([
            { constantName: "ASSISTANT", wireValue: "assistant" },
            { constantName: "REVIEWER", wireValue: "reviewer" },
        ]);
    });
});

// ============================================================
// Java parser (rich schema fixture)
// ============================================================

describe("Java parser (rich schema fixture)", () => {
    const root = path.join(FIXTURES, "java-schema");
    const parser = createJavaParser();
    const endpoints = parser.parseEndpoints(root);
    const createAgent = endpoints.find((e) => e.methodName === "createAgent")!;

    test("extracts positional params with snake_case names matching URL template", () => {
        // Java method `createAgent(String orgId, String teamId, ..., request, ...)`
        // → URL template `{org_id}` / `{team_id}`. Consumer keys path-param
        // substitutions by the wire (snake_case) names.
        expect(createAgent.javaPositionalParams).toEqual([
            { name: "orgId", type: "String" },
            { name: "teamId", type: "String" },
        ]);
        expect(createAgent.renderSchema?.params).toEqual([
            { name: "org_id", kind: "string" },
            { name: "team_id", kind: "string" },
        ]);
    });

    test("emits a callTemplate that interleaves path params with the body builder", () => {
        // The body builder always trails the path params and follows the
        // RequestClass.builder()...build() shape.
        expect(createAgent.renderSchema?.callTemplate).toBe(
            "client.agent().createAgent({{org_id}}, {{team_id}}, CreateAgentRequest.builder(){{__body__}}.build())",
        );
    });

    test("body schema lists required fields first, then optional, and includes per-kind metadata", () => {
        const fields = createAgent.renderSchema?.body?.fields ?? [];
        const keys = fields.map((f) => f.jsonKey);
        // Required (staged-builder order) before optionals; @JsonIgnore'd
        // header field (phenomlOnBehalfOf) excluded entirely.
        expect(keys).toEqual(["name", "role", "tools", "categories", "description"]);
        expect(fields[0]).toMatchObject({ kind: "string", required: true });
        expect(fields[1]).toMatchObject({ kind: "enum", required: true });
        expect(fields[1].enumValues).toEqual(["assistant", "reviewer", "custom"]);
        // Java enum setters take the enum type, so the renderer needs the
        // `EnumName.CONSTANT` expression — emitting `.role("assistant")`
        // would fail to compile.
        expect(fields[1].enumConstants).toEqual({
            "assistant": "AgentRole.ASSISTANT",
            "reviewer": "AgentRole.REVIEWER",
            "custom": "AgentRole.CUSTOM",
        });
        expect(fields[2]).toMatchObject({ kind: "list", required: false });
        expect(fields[2].items).toMatchObject({ kind: "string" });
        // List-of-object recurses into the Tag class's field catalog.
        expect(fields[3]).toMatchObject({ kind: "list", required: false });
        expect(fields[3].items?.kind).toBe("object");
        const tagKeys = fields[3].items?.nested?.fields.map((f) => f.jsonKey) ?? [];
        expect(tagKeys).toEqual(["name", "color"]);
        // The nested Tag schema must carry the Java builder envelope, or
        // the consumer's renderer would emit `Arrays.asList(.name("x")...)`
        // — invalid Java since the bare fluent chain has no receiver.
        expect(fields[3].items?.nested?.wrap).toBe("Tag.builder(){{__body__}}.build()");
        expect(fields[4]).toMatchObject({ kind: "string", required: false });
    });

    test("fieldTemplate uses the camelCase setter name and {{value}} placeholder", () => {
        const fields = createAgent.renderSchema?.body?.fields ?? [];
        expect(fields.map((f) => f.fieldTemplate)).toEqual([
            ".name({{value}})",
            ".role({{value}})",
            ".tools({{value}})",
            ".categories({{value}})",
            ".description({{value}})",
        ]);
        expect(createAgent.renderSchema?.body?.fieldSeparator).toBe("");
    });
});

describe("Java parser (AuthtokenAuth fixture) — render schema", () => {
    const root = path.join(FIXTURES, "java");
    const parser = createJavaParser();
    const endpoints = parser.parseEndpoints(root);
    const generateToken = endpoints.find((e) => e.methodName === "generateToken")!;

    test("end-to-end render schema for an endpoint with no path params", () => {
        // No positional args → `params` is empty and the call template
        // contains only the body-builder placeholder.
        expect(generateToken.renderSchema).toMatchObject({
            callTemplate: "client.authtoken().auth().generateToken(AuthGenerateTokenRequest.builder(){{__body__}}.build())",
            params: [],
            body: {
                fieldSeparator: "",
                fields: [
                    { jsonKey: "username", fieldTemplate: ".username({{value}})", kind: "string", required: true },
                    { jsonKey: "password", fieldTemplate: ".password({{value}})", kind: "string", required: true },
                    { jsonKey: "scope", fieldTemplate: ".scope({{value}})", kind: "string", required: false },
                ],
            },
        });
    });

    test("renderRules + render schema land in the assembled manifest", () => {
        const examples = parser.parseTestExamples(root);
        const meta = { generatorName: "fernapi/fern-java-sdk", sdkVersion: "0.0.0", originGitCommit: "deadbeef" };
        const manifest = buildManifest(endpoints, examples, "java", "com.phenoml", meta);
        expect(manifest.renderRules.listLiteral).toBe("Arrays.asList({{items}})");
        const example = manifest.examples["POST /auth/token"];
        expect(example.render?.callTemplate).toContain("AuthGenerateTokenRequest.builder()");
    });
});

// ============================================================
// buildManifest — chain-index collision handling
// ============================================================

// ============================================================
// buildManifest — renderRules
// ============================================================

describe("buildManifest renderRules", () => {
    const metadata = {
        generatorName: "fernapi/fern-typescript-sdk",
        sdkVersion: "0.0.0",
        originGitCommit: "deadbeef",
    };

    test("emits language-appropriate render constants", () => {
        // Single source of truth for downstream renderers — Python's boolean
        // capitalization and Java's Arrays.asList wrapper are the things
        // that distinguish languages most visibly.
        const ts = buildManifest([], [], "typescript", "pkg", metadata);
        expect(ts.renderRules.trueLiteral).toBe("true");
        expect(ts.renderRules.listLiteral).toBe("[{{items}}]");
        const py = buildManifest([], [], "python", "pkg", metadata);
        expect(py.renderRules.trueLiteral).toBe("True");
        expect(py.renderRules.nullLiteral).toBe("None");
        const java = buildManifest([], [], "java", "pkg", metadata);
        expect(java.renderRules.listLiteral).toBe("Arrays.asList({{items}})");
    });
});

describe("buildManifest chain-index", () => {
    const metadata = {
        generatorName: "fernapi/fern-java-sdk",
        sdkVersion: "0.0.0",
        originGitCommit: "deadbeef",
    };

    test("matches a Java example by chain when httpPath is missing", () => {
        const endpoints = [
            {
                httpMethod: "POST",
                httpPath: "/agent/prompts/create",
                methodChain: ["agent", "prompts", "create"],
                methodName: "create",
            },
        ];
        const examples = [
            {
                httpMethod: "POST",
                httpPath: "",
                methodName: "create",
                describeBlock: "AgentPromptsWireTest.java",
                requestBody: { name: "x" },
                responseBody: { id: "y" },
                sdkCallArgs: [],
                sdkCallSource: "client.agent().prompts().create(...)",
            },
        ];
        const manifest = buildManifest(endpoints, examples, "java", "pkg", metadata);
        expect(Object.keys(manifest.examples)).toEqual(["POST /agent/prompts/create"]);
        expect(manifest.examples["POST /agent/prompts/create"].request.body).toEqual({ name: "x" });
    });

    test("drops the ambiguous entry when two chains collide on the same key", () => {
        // ["agent", "prompts"] and ["agentp", "rompts"] both lowercase-concat
        // to "agentprompts" and would silently map a single test example to
        // whichever endpoint happens to be indexed last. The fix removes both
        // from the chain index so lookup misses instead of guessing wrong.
        const endpoints = [
            {
                httpMethod: "POST",
                httpPath: "/agent/prompts/create",
                methodChain: ["agent", "prompts", "create"],
                methodName: "create",
            },
            {
                httpMethod: "POST",
                httpPath: "/agentp/rompts/create",
                methodChain: ["agentp", "rompts", "create"],
                methodName: "create",
            },
        ];
        const examples = [
            {
                httpMethod: "POST",
                httpPath: "",
                methodName: "create",
                describeBlock: "AgentPromptsWireTest.java",
                requestBody: null,
                responseBody: null,
                sdkCallArgs: [],
                sdkCallSource: "",
            },
        ];
        const manifest = buildManifest(endpoints, examples, "java", "pkg", metadata);
        // Neither endpoint should be matched via the (now-dropped) chain index.
        expect(Object.keys(manifest.examples)).toEqual([]);
    });
});

describe("buildManifest example-richness", () => {
    const metadata = {
        generatorName: "fernapi/fern-python-sdk",
        sdkVersion: "0.0.0",
        originGitCommit: "deadbeef",
    };
    const endpoint = {
        httpMethod: "POST",
        httpPath: "/foo",
        methodChain: ["foo"],
        methodName: "foo",
        bodyParamMap: { name: "name" },
    };
    const rich = {
        httpMethod: "POST",
        httpPath: "/foo",
        methodName: "foo",
        describeBlock: "",
        requestBody: null,
        responseBody: { ok: true },
        sdkCallArgs: [{ name: "name", value: "x" }],
        sdkCallSource: 'client.foo.foo(name="x")',
    };
    const poor = {
        httpMethod: "POST",
        httpPath: "/foo",
        methodName: "foo",
        describeBlock: "",
        requestBody: null,
        responseBody: null,
        sdkCallArgs: [],
        sdkCallSource: "client.foo.foo()",
    };

    test("keeps the kwarg-bearing example when a later test has no kwargs", () => {
        // Bug: when fixture files sort such that a no-kwargs test comes
        // AFTER a kwargs-bearing test for the same endpoint, the later
        // (poorer) example used to overwrite the richer one, erasing the
        // derived body and sdkCallArgs.
        const manifest = buildManifest([endpoint], [rich, poor], "python", "pkg", metadata);
        expect(manifest.examples["POST /foo"].request.body).toEqual({ name: "x" });
        expect(manifest.examples["POST /foo"].request.sdkCallArgs).toEqual([{ name: "name", value: "x" }]);
    });

    test("rich example overrides an earlier poor one (order-independent)", () => {
        const manifest = buildManifest([endpoint], [poor, rich], "python", "pkg", metadata);
        expect(manifest.examples["POST /foo"].request.body).toEqual({ name: "x" });
    });
});

describe("buildManifest streaming endpoints", () => {
    const metadata = {
        generatorName: "fernapi/fern-java-sdk",
        sdkVersion: "0.0.0",
        originGitCommit: "deadbeef",
    };

    test("replaces the mock placeholder response with `streaming: true` and a null body", () => {
        // The Java wire-test pattern enqueues a `{}` MockResponse for SSE
        // endpoints because the test only exercises the request side — the
        // SDK never parses that body. Without isStreaming, the manifest
        // would advertise `response.body = {}`, misleading downstream docs.
        const endpoints = [
            {
                httpMethod: "POST",
                httpPath: "/agent/stream-chat",
                methodChain: ["agent", "streamChat"],
                methodName: "streamChat",
                isStreaming: true,
            },
        ];
        const examples = [
            {
                httpMethod: "POST",
                httpPath: "/agent/stream-chat",
                methodName: "streamChat",
                describeBlock: "",
                requestBody: { message: "hi" },
                responseBody: {},
                sdkCallArgs: [],
                sdkCallSource: "client.agent().streamChat(...)",
            },
        ];
        const manifest = buildManifest(endpoints, examples, "java", "pkg", metadata);
        const example = manifest.examples["POST /agent/stream-chat"];
        expect(example.response).toEqual({ body: null, streaming: true });
        expect(example.request.body).toEqual({ message: "hi" });
    });

    test("leaves non-streaming endpoints untouched", () => {
        // Sanity check: the streaming branch must not regress the default
        // JSON-body path that non-SSE endpoints rely on.
        const endpoints = [
            {
                httpMethod: "POST",
                httpPath: "/agent/chat",
                methodChain: ["agent", "chat"],
                methodName: "chat",
            },
        ];
        const examples = [
            {
                httpMethod: "POST",
                httpPath: "/agent/chat",
                methodName: "chat",
                describeBlock: "",
                requestBody: { message: "hi" },
                responseBody: { reply: "hello" },
                sdkCallArgs: [],
                sdkCallSource: "client.agent().chat(...)",
            },
        ];
        const manifest = buildManifest(endpoints, examples, "java", "pkg", metadata);
        expect(manifest.examples["POST /agent/chat"].response).toEqual({ body: { reply: "hello" } });
    });
});
