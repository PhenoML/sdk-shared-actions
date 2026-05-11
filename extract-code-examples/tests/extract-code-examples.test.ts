import { afterAll, describe, expect, test } from "bun:test";
import * as path from "path";
import {
    buildManifest,
    camelToSnake,
    createJavaParser,
    createPythonParser,
    createTypeScriptParser,
    isBalancedParens,
    javaCountBraceDelta,
    javaDeriveMethodChain,
    javaExtractConcatenatedString,
    javaExtractSetBody,
    javaUnescape,
    normalizePath,
    normalizePathParams,
    pyDeriveMethodChain,
    pyExtractHttpMethod,
    pyExtractRequestPath,
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
});

describe("javaDeriveMethodChain", () => {
    test("derives chain from path under resources/", () => {
        const chain = javaDeriveMethodChain(
            "/sdk/src/main/java/com/phenoml/api/resources/authtoken/auth/RawAuthClient.java",
            "/sdk/src/main/java/com/phenoml/api/resources",
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
});

describe("Python parser (Authtoken auth fixture)", () => {
    const root = path.join(FIXTURES, "python");
    const parser = createPythonParser();
    const endpoints = parser.parseEndpoints(root);
    const examples = parser.parseTestExamples(root);

    test("parseEndpoints extracts get_token", () => {
        expect(endpoints).toHaveLength(1);
        expect(endpoints[0]).toMatchObject({
            httpMethod: "POST",
            httpPath: "/v2/auth/token",
            methodName: "get_token",
            methodChain: ["authtoken", "auth", "get_token"],
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
