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
    javaBuildAccessorMap,
    javaCountBraceDelta,
    javaDeriveMethodChain,
    javaExtractConcatenatedString,
    javaExtractSetBody,
    javaUnescape,
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

    test("parseEndpoints extracts all 6 Summary endpoints", () => {
        const keys = endpoints.map((e) => `${e.httpMethod} ${e.httpPath}`).sort();
        expect(keys).toEqual([
            "DELETE /fhir2summary/template/{id}",
            "GET /fhir2summary/template/{id}",
            "GET /fhir2summary/templates",
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
        // The Summary fixture has 6 methods, each with several numbered variants
        // ((1) success, (2)/(3) error cases). Only the (1) success cases should
        // be extracted.
        expect(examples).toHaveLength(6);
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
        // Both test files should yield an example (no truncation drops one).
        expect(examples.filter((e) => e.httpPath === "/v2/auth/token").length).toBe(2);
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
});

// ============================================================
// buildManifest — chain-index collision handling
// ============================================================

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
