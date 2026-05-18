import * as fs from "fs";
import * as path from "path";
import type {
    BodySchema,
    EndpointMapping,
    RenderSchema,
    SchemaField,
    SchemaFieldKind,
} from "../types";

// Information about one Python method kwarg pulled from a raw client.
export interface PyKwarg {
    name: string;
    typeAnnotation: string;
    // Whether the kwarg has a default value (` = None`, ` = OMIT`, ...). If
    // it does, the field is optional from the caller's perspective.
    hasDefault: boolean;
}

// Find a Fern Python raw-client method and return its kwargs + type
// annotations. `methodName` is matched against the first sync-class def;
// the async class declares the same methods so the first hit is correct.
// Skips the trailing `request_options` kwarg.
export function pyExtractMethodKwargs(filePathOrLines: string | string[], methodName: string): PyKwarg[] {
    const lines = typeof filePathOrLines === "string"
        ? pyReadLines(filePathOrLines)
        : filePathOrLines;
    if (!lines) return [];
    for (let i = 0; i < lines.length; i++) {
        if (!new RegExp(`^\\s{4}def\\s+${methodName}\\s*\\(`).test(lines[i])) continue;
        return pyParseSignatureKwargs(lines, i);
    }
    return [];
}

function pyReadLines(filePath: string): string[] | null {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8").split("\n");
}

// Walk from a `def methodName(` line to the matching `)`, collecting kwargs
// of the form `name: type` or `name: type = default`. Multi-line signatures
// are the norm (Fern emits one kwarg per line); we accumulate until parens
// balance.
export function pyParseSignatureKwargs(lines: string[], defLine: number): PyKwarg[] {
    const openIdx = lines[defLine].indexOf("(");
    if (openIdx < 0) return [];
    let depth = 1;
    let paramText = "";
    for (let i = defLine; i < Math.min(defLine + 60, lines.length); i++) {
        const startCol = i === defLine ? openIdx + 1 : 0;
        const text = lines[i].slice(startCol);
        for (let c = 0; c < text.length; c++) {
            const ch = text[c];
            if (ch === "(" || ch === "[") depth++;
            else if (ch === ")" || ch === "]") {
                depth--;
                if (depth === 0) {
                    paramText += text.slice(0, c);
                    return pySplitKwargs(paramText);
                }
            }
        }
        paramText += text + " ";
    }
    return [];
}

// Split a Python parameter list on top-level commas (ignoring those nested
// inside brackets). Filters out `self`, `*` (keyword-only marker), and
// `request_options`.
function pySplitKwargs(text: string): PyKwarg[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "[" || c === "(" || c === "{") depth++;
        else if (c === "]" || c === ")" || c === "}") depth--;
        else if (c === "," && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));

    const out: PyKwarg[] = [];
    for (const raw of parts) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (trimmed === "self" || trimmed === "*") continue;
        if (trimmed.startsWith("self,") || trimmed === "/") continue;
        if (trimmed.startsWith("request_options")) continue;

        // Match `name: type = default` or `name: type`. Capture the type as
        // everything between `:` and `=` (or end-of-string if no default).
        const m = trimmed.match(/^(\w+)\s*:\s*([\s\S]+?)(?:\s*=\s*([\s\S]+))?$/);
        if (!m) continue;
        out.push({
            name: m[1],
            typeAnnotation: m[2].trim(),
            hasDefault: m[3] !== undefined,
        });
    }
    return out;
}

// Locate the `headers={...}` argument inside a Fern Python raw client
// method body and return the set of kwarg identifiers it references. Used
// to mark header-only kwargs so they're excluded from the body schema.
export function pyExtractHeaderKwargs(filePathOrLines: string | string[], methodName: string): Set<string> {
    const out = new Set<string>();
    const lines = typeof filePathOrLines === "string"
        ? pyReadLines(filePathOrLines)
        : filePathOrLines;
    if (!lines) return out;

    let inMethod = false;
    let headersBuf = "";
    let headersDepth = 0;
    for (const line of lines) {
        if (new RegExp(`^\\s{4}def\\s+${methodName}\\s*\\(`).test(line)) inMethod = true;
        else if (inMethod && /^\s{4}def\s+\w+/.test(line)) break;
        if (!inMethod) continue;

        if (headersDepth === 0) {
            const idx = line.indexOf("headers=");
            if (idx >= 0) {
                const after = line.slice(idx + "headers=".length);
                if (after.trimStart().startsWith("{")) {
                    headersBuf = after;
                    headersDepth = countBraces(after);
                    if (headersDepth === 0 && headersBuf.includes("}")) break;
                }
            }
        } else {
            headersBuf += "\n" + line;
            headersDepth += countBraces(line);
            if (headersDepth <= 0) break;
        }
    }

    // Pull identifier names referenced inside the headers dict; the dict
    // values are either string literals (skip) or kwarg references like
    // `str(phenoml_on_behalf_of) if phenoml_on_behalf_of is not None else None`.
    for (const m of headersBuf.matchAll(/\b([a-z_][a-z_0-9]*)\b/g)) {
        const id = m[1];
        // Filter Python builtins and common helpers that appear in the
        // generated `str(x) if x is not None else None` ternary.
        if (["str", "int", "float", "if", "is", "not", "None", "else", "True", "False", "headers", "content"].includes(id)) continue;
        out.add(id);
    }
    return out;
}

function countBraces(s: string): number {
    let n = 0;
    for (const c of s) {
        if (c === "{") n++;
        else if (c === "}") n--;
    }
    return n;
}

const PY_PRIMITIVE_KIND: Record<string, SchemaFieldKind> = {
    str: "string",
    bytes: "string",
    int: "number",
    float: "number",
    bool: "boolean",
};

// Map a Python type annotation to a SchemaFieldKind. Recognizes the few
// shapes Fern emits: scalars, `Optional[T]`, `Sequence[T]`/`List[T]`,
// `Union[Literal[...], Any]` enums. Anything else falls back to "object".
export function pyInferKind(typeExpr: string): SchemaFieldKind {
    const stripped = pyStripOptional(typeExpr).trim();
    if (PY_PRIMITIVE_KIND[stripped] !== undefined) return PY_PRIMITIVE_KIND[stripped];
    if (/^typing\.(Sequence|List)\b/.test(stripped) || /^(Sequence|List)\b/.test(stripped)) return "list";
    // Fern emits enums as `Union[Literal["a","b",...], Any]` — recognized
    // when the type starts with a `Literal[...]` clause.
    if (/Literal\s*\[/.test(stripped)) return "enum";
    return "object";
}

export function pyStripOptional(typeExpr: string): string {
    const m = typeExpr.match(/^(?:typing\.)?Optional\s*\[([\s\S]+)\]\s*$/);
    return m ? m[1].trim() : typeExpr;
}

export function pyUnwrapList(typeExpr: string): string {
    const m = pyStripOptional(typeExpr).match(/^(?:typing\.)?(?:Sequence|List)\s*\[([\s\S]+)\]\s*$/);
    return m ? m[1].trim() : "object";
}

// Pull literal values out of a Python `Literal[...]` clause. Used for the
// `Union[Literal["a","b"], Any]` enum pattern.
export function pyExtractEnumValues(typeExpr: string): string[] {
    const literal = typeExpr.match(/Literal\s*\[([\s\S]+?)\]/);
    if (!literal) return [];
    const out: string[] = [];
    for (const m of literal[1].matchAll(/"([^"]+)"/g)) out.push(m[1]);
    return out;
}

// Build a RenderSchema for one Python endpoint. Python Fern signatures are
// all-kwarg style, so the call template is just `client.x.y({{__body__}})`
// and path params + body fields collapse into a single BodySchema for
// consumer-side simplicity. `linesCache`, when supplied, lets repeated
// endpoints in the same raw_client.py share one file read.
export function buildPythonRenderSchema(
    endpoint: EndpointMapping,
    pkgRoot: string,
    linesCache?: Map<string, string[]>,
): RenderSchema {
    const filePath = pythonRawClientFile(endpoint, pkgRoot);
    if (!filePath) return { callTemplate: pythonCallTemplate(endpoint), params: [] };

    let lines = linesCache?.get(filePath);
    if (!lines) {
        const read = pyReadLines(filePath);
        if (!read) return { callTemplate: pythonCallTemplate(endpoint), params: [] };
        lines = read;
        linesCache?.set(filePath, lines);
    }
    const kwargs = pyExtractMethodKwargs(lines, endpoint.methodName);
    const headerKwargs = pyExtractHeaderKwargs(lines, endpoint.methodName);
    const pathParams = new Set<string>();
    for (const m of endpoint.httpPath.matchAll(/\{(\w+)\}/g)) pathParams.add(m[1]);

    const fields: SchemaField[] = [];
    for (const kw of kwargs) {
        // Header kwargs ship via HTTP headers, not in the body or URL.
        if (headerKwargs.has(kw.name) && !pathParams.has(kw.name)) continue;
        // Treat path-param kwargs as schema fields so the consumer can
        // supply them via the same input map as body fields.
        const jsonKey = endpoint.bodyParamMap?.[kw.name] ?? kw.name;
        fields.push(pyToSchemaField(kw, jsonKey));
    }

    const body: BodySchema | undefined = fields.length > 0
        ? { fieldSeparator: ", ", fields }
        : undefined;

    const schema: RenderSchema = {
        callTemplate: pythonCallTemplate(endpoint),
        params: [],
    };
    if (body) schema.body = body;
    return schema;
}

function pyToSchemaField(kw: PyKwarg, jsonKey: string): SchemaField {
    const kind = pyInferKind(kw.typeAnnotation);
    const field: SchemaField = {
        jsonKey,
        fieldTemplate: `${kw.name}={{value}}`,
        kind,
        required: !kw.hasDefault,
    };
    if (kind === "list") {
        const inner = pyUnwrapList(kw.typeAnnotation);
        field.items = {
            jsonKey: "",
            fieldTemplate: "{{value}}",
            kind: pyInferKind(inner),
            required: true,
        };
    } else if (kind === "enum") {
        field.enumValues = pyExtractEnumValues(kw.typeAnnotation);
    }
    return field;
}

function pythonCallTemplate(endpoint: EndpointMapping): string {
    const accessors = endpoint.methodChain.slice(0, -1);
    const chainStr = ["client", ...accessors].join(".") + "." + endpoint.methodName;
    return `${chainStr}({{__body__}})`;
}

// Locate the raw_client.py file for an endpoint's method chain. The chain
// excludes the "resources" intermediate directory Fern uses; we add it
// back when looking up the file on disk.
export function pythonRawClientFile(endpoint: EndpointMapping, pkgRoot: string): string | null {
    const accessors = endpoint.methodChain.slice(0, -1);
    // Try the direct chain first, then with "resources" interleaved (which
    // is how Fern lays out nested sub-clients on disk).
    const candidates = [
        path.join(pkgRoot, ...accessors, "raw_client.py"),
        path.join(pkgRoot, accessors[0] ?? "", "resources", ...accessors.slice(1), "raw_client.py"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}
