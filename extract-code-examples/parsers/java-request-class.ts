import * as fs from "fs";
import * as path from "path";
import type { BodySchema, SchemaField, SchemaFieldKind } from "../types";

// Per-field info pulled from a Fern-generated Java request class. The
// downstream BodySchema builder consumes this together with endpoint-level
// information (which JSON keys actually land in the body vs. headers) to
// produce the render schema.
export interface JavaFieldInfo {
    jsonKey: string;        // From @JsonProperty(...) on the getter
    fieldName: string;      // Java field identifier (camelCase)
    javaSetter: string;     // Builder method name (matches fieldName)
    rawType: string;        // Raw declared type, e.g. "Optional<List<String>>"
    innerType: string;      // rawType with the outer Optional<> stripped
    isOptional: boolean;    // Wrapped in Optional<> on the field?
}

export interface JavaClassInfo {
    className: string;
    // Resolved absolute path of the class file (helps recursive lookups).
    filePath: string;
    fields: JavaFieldInfo[];
    // Field names whose getter carries `@JsonIgnore`. Fern uses this for
    // request fields that ship as HTTP headers rather than in the JSON body
    // (the @JsonProperty-with-header-name pattern is the older variant).
    ignoredFields: Set<string>;
    // Field names in staged-builder order. The Fern staged-builder pattern
    // forces required fields to be set in a fixed order before optional
    // ones; consumer code needs that order to emit a syntactically valid
    // call when a user "starts from scratch". Empty when the class doesn't
    // use staged builders (rare; defensive fallback to field-declaration
    // order).
    requiredOrder: string[];
    // FQN imports parsed from the file, so callers can resolve nested type
    // names (e.g. `List<Tag>` → `com.phenoml.api.resources.tools.types.Tag`).
    imports: Map<string, string>;
    // For enum classes, the constant-name / wire-value pairs; absent for
    // object classes. Order matches declaration order in the source.
    enumConstants?: JavaEnumConstant[];
}

// Build a (possibly nested) `BodySchema` for a Fern Java request class.
// `headerJsonKeys` lists keys the raw client diverts to HTTP headers — they
// are part of the class but NOT the body. `bodyJsonKeys`, when set, narrows
// further to an explicit `properties.put(...)` list. `visited` is reused
// across recursive calls to prevent cycles in self-referential schemas.
export function buildJavaBodySchema(
    classInfo: JavaClassInfo,
    options: {
        headerJsonKeys?: Set<string>;
        bodyJsonKeys?: string[];
        visited?: Set<string>;
    } = {},
): BodySchema {
    const headers = options.headerJsonKeys ?? new Set<string>();
    const explicitBody = options.bodyJsonKeys;
    const visited = options.visited ?? new Set<string>();

    const eligible = classInfo.fields.filter((f) => {
        if (classInfo.ignoredFields.has(f.fieldName)) return false;
        if (headers.has(f.jsonKey)) return false;
        if (explicitBody && !explicitBody.includes(f.jsonKey)) return false;
        return true;
    });

    // Order: required (per staged builder) first, then optional in
    // declaration order. The consumer can choose to render only the user's
    // populated fields, but having a stable canonical order means
    // identical inputs render identical strings.
    const ordered: JavaFieldInfo[] = [];
    const seen = new Set<string>();
    for (const name of classInfo.requiredOrder) {
        const f = eligible.find((x) => x.fieldName === name);
        if (f) { ordered.push(f); seen.add(f.fieldName); }
    }
    for (const f of eligible) {
        if (!seen.has(f.fieldName)) ordered.push(f);
    }

    const fields: SchemaField[] = ordered.map((f) =>
        toSchemaField(f, classInfo, visited),
    );

    return {
        // Each Java setter is invoked as a fluent chain — no separator
        // between calls; the `.` lives at the start of each fieldTemplate.
        fieldSeparator: "",
        fields,
    };
}

function toSchemaField(
    f: JavaFieldInfo,
    owner: JavaClassInfo,
    visited: Set<string>,
): SchemaField {
    const field: SchemaField = {
        jsonKey: f.jsonKey,
        fieldTemplate: `.${f.javaSetter}({{value}})`,
        // Initial kind from the static type expression; refined below
        // once we know whether a referenced class is an enum or object.
        kind: inferKind(f.innerType),
        // A staged-builder required field has no Optional wrapper.
        required: !f.isOptional && owner.requiredOrder.includes(f.fieldName),
    };

    if (field.kind === "list") {
        field.items = listItemField(unwrapList(f.innerType), owner, visited);
    } else if (field.kind === "object") {
        // inferKind only sees the type name — it can't distinguish a Fern
        // enum from a regular class. Resolve the file and reclassify.
        const resolved = resolveNestedClass(f.innerType, owner, visited);
        if (resolved?.enumConstants) {
            applyJavaEnum(field, resolved);
        } else if (resolved) {
            field.nested = buildJavaBodySchema(resolved, { visited });
        }
    }
    return field;
}

// Promote a field that resolved to a Java enum class. Carries both the
// wire-value list (for UI dropdowns) AND the `EnumName.CONSTANT`
// expressions a Java renderer must emit — otherwise `.role("assistant")`
// goes out, which fails to typecheck against `role(AgentRole role)`.
function applyJavaEnum(field: SchemaField, resolved: JavaClassInfo): void {
    if (!resolved.enumConstants) return;
    field.kind = "enum";
    field.enumValues = resolved.enumConstants.map((c) => c.wireValue);
    field.enumConstants = Object.fromEntries(
        resolved.enumConstants.map((c) => [c.wireValue, `${resolved.className}.${c.constantName}`]),
    );
}

// Build a synthetic SchemaField representing one element of a list. Reuses
// the same kind inference + nested-resolution path so List<Tag> recursively
// reveals Tag's field catalog.
function listItemField(
    itemType: string,
    owner: JavaClassInfo,
    visited: Set<string>,
): SchemaField {
    const kind = inferKind(itemType);
    const item: SchemaField = {
        jsonKey: "",       // Items don't have their own JSON key
        fieldTemplate: "{{value}}",
        kind,
        required: true,
    };
    if (item.kind === "list") {
        item.items = listItemField(unwrapList(itemType), owner, visited);
    } else if (item.kind === "object") {
        const resolved = resolveNestedClass(itemType, owner, visited);
        if (resolved?.enumConstants) {
            applyJavaEnum(item, resolved);
        } else if (resolved) {
            item.nested = buildJavaBodySchema(resolved, { visited });
        }
    }
    return item;
}

// Single source of truth for Java type-name → SchemaFieldKind. Includes
// both class types (used in request-class field declarations) and the
// lowercase primitives Fern surfaces on path/query method params.
export const JAVA_PRIMITIVE_KIND: Record<string, SchemaFieldKind> = {
    String: "string",
    CharSequence: "string",
    UUID: "string",
    Instant: "string",
    OffsetDateTime: "string",
    LocalDate: "string",
    LocalDateTime: "string",
    Integer: "number",
    Long: "number",
    Double: "number",
    Float: "number",
    Short: "number",
    Byte: "number",
    BigDecimal: "number",
    BigInteger: "number",
    Number: "number",
    Boolean: "boolean",
    // Primitives — only ever appear as positional Java method params.
    int: "number",
    long: "number",
    short: "number",
    byte: "number",
    double: "number",
    float: "number",
    boolean: "boolean",
};

// Map a Java type expression to a SchemaFieldKind. Anything not recognized
// as a primitive, list, or known wrapper is classified as "object"; the
// resolver tries to load it from disk and reclassifies to "enum" when the
// file turns out to be a Java enum.
export function inferKind(rawType: string): SchemaFieldKind {
    const t = rawType.trim();
    if (/^(List|Set|Collection|Iterable|Sequence)\s*</.test(t)) return "list";
    const simple = t.replace(/<.*$/, "").trim();
    if (JAVA_PRIMITIVE_KIND[simple] !== undefined) return JAVA_PRIMITIVE_KIND[simple];
    // Caller will follow up with resolveNestedClass; if that returns an enum
    // we patch the kind to "enum" at the use site.
    return "object";
}

function unwrapList(rawType: string): string {
    const m = rawType.trim().match(/^(?:List|Set|Collection|Iterable|Sequence)\s*<\s*([\s\S]+)\s*>\s*$/);
    return m ? m[1].trim() : "Object";
}

// Resolve a type-name reference inside `owner` to a parsed JavaClassInfo on
// disk, returning null when the type isn't a class we can read (primitives,
// types from external packages we don't ship, etc). `visited` prevents
// infinite recursion on self-referential schemas (e.g. a tree node type).
function resolveNestedClass(
    rawType: string,
    owner: JavaClassInfo,
    visited: Set<string>,
): JavaClassInfo | null {
    const simple = rawType.trim().replace(/<.*$/, "").trim();
    if (!simple || JAVA_PRIMITIVE_KIND[simple] !== undefined) return null;
    if (visited.has(simple)) return null;
    visited.add(simple);

    const javaDir = findJavaRoot(owner.filePath);
    if (!javaDir) return null;
    const fqn = owner.imports.get(simple);
    let filePath: string | null = null;
    if (fqn) {
        const candidate = path.join(javaDir, fqn.replace(/\./g, "/") + ".java");
        if (fs.existsSync(candidate)) filePath = candidate;
    } else {
        // Same-package fallback: look next to `owner.filePath`.
        const sibling = path.join(path.dirname(owner.filePath), simple + ".java");
        if (fs.existsSync(sibling)) filePath = sibling;
    }
    if (!filePath) return null;
    return parseJavaClass(filePath);
}

// Recognize this as a Java source root so we can resolve FQN imports to file
// paths. Walks parents until "src/main/java" or "src/test/java" is the
// suffix; that prefix is exactly the package-path root.
function findJavaRoot(filePath: string): string | null {
    let dir = path.dirname(filePath);
    while (dir && dir !== "/" && dir !== ".") {
        if (dir.endsWith("/src/main/java") || dir.endsWith("/src/test/java")) return dir;
        dir = path.dirname(dir);
    }
    return null;
}

// Parse a single Fern-generated Java type file into a JavaClassInfo. Cheap
// best-effort regex-based — Fern's output is uniform enough that we don't
// need a real Java parser, and the failure mode (return null / skip a
// field) is graceful: the manifest just won't expose the unparseable bit.
export function parseJavaClass(filePath: string): JavaClassInfo | null {
    if (!fs.existsSync(filePath)) return null;
    const source = fs.readFileSync(filePath, "utf-8");
    const imports = parseJavaImports(source);

    // Class name from the outermost `class` or `enum` declaration.
    const classMatch = source.match(/public\s+(?:final\s+)?(class|enum)\s+(\w+)/);
    if (!classMatch) return null;
    const declKind = classMatch[1];
    const className = classMatch[2];

    if (declKind === "enum") {
        return {
            className,
            filePath,
            fields: [],
            requiredOrder: [],
            imports,
            ignoredFields: new Set(),
            enumConstants: parseJavaEnumValues(source),
        };
    }

    const fields = parseJavaFieldDeclarations(source);
    const jsonKeyByField = parseJavaJsonProperties(source);
    for (const f of fields) {
        const key = jsonKeyByField.get(f.fieldName);
        if (key) f.jsonKey = key;
    }
    const requiredOrder = parseJavaStagedBuilderOrder(source);
    const ignoredFields = parseJavaJsonIgnoredFields(source);

    return { className, filePath, fields, requiredOrder, imports, ignoredFields };
}

// Pull `private final <type> <name>;` declarations from the OUTERMOST class
// body. Fern request classes commonly nest inline union/builder types with
// their own `private final` fields; scanning indiscriminately would pull
// those in too and corrupt the catalog. Skips the boilerplate
// `additionalProperties` Map Fern adds to every class.
export function parseJavaFieldDeclarations(source: string): JavaFieldInfo[] {
    const out: JavaFieldInfo[] = [];
    // Find the outer class's opening `{`, then walk until its matching `}`,
    // tracking depth. We collect candidate field-declaration lines only when
    // we sit at depth 1 (immediately inside the outer class body).
    const classMatch = source.match(/\b(?:class|interface)\s+\w+[^{]*\{/);
    if (!classMatch) return out;
    const startIdx = (classMatch.index ?? 0) + classMatch[0].length;

    let depth = 1;
    let lineBuf = "";
    const consumeLine = (line: string) => {
        const m = line.match(/^\s*private\s+final\s+([^;=]+?)\s+(\w+)\s*;\s*$/);
        if (!m) return;
        const rawType = m[1].trim();
        const fieldName = m[2];
        if (fieldName === "additionalProperties") return;
        const optMatch = rawType.match(/^Optional\s*<\s*([\s\S]+)\s*>\s*$/);
        const innerType = optMatch ? optMatch[1].trim() : rawType;
        out.push({
            jsonKey: fieldName,          // Default; @JsonProperty may override below
            fieldName,
            javaSetter: fieldName,
            rawType,
            innerType,
            isOptional: optMatch !== null,
        });
    };

    for (let i = startIdx; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") { depth++; continue; }
        if (ch === "}") {
            depth--;
            if (depth === 0) break;
            continue;
        }
        if (ch === "\n") {
            if (depth === 1) consumeLine(lineBuf);
            lineBuf = "";
            continue;
        }
        if (depth === 1) lineBuf += ch;
    }
    if (depth === 1 && lineBuf.trim()) consumeLine(lineBuf);
    return out;
}

// Walk `@JsonProperty("wire-name") ... getFieldName()` pairs and produce a
// fieldName → wire-name map. Fern emits both the annotation and the camel
// getter in lockstep, so a regex over the (annotation, getter) pair is
// reliable.
export function parseJavaJsonProperties(source: string): Map<string, string> {
    const out = new Map<string, string>();
    const pattern = /@JsonProperty\s*\(\s*"([^"]+)"\s*\)\s*[\s\S]*?public\s+\S[^()]*\s+get(\w+)\s*\(/g;
    for (const m of source.matchAll(pattern)) {
        const jsonKey = m[1];
        const getterSuffix = m[2];
        // Fern getters camelCase the field, so "getPhenomlOnBehalfOf" → field
        // "phenomlOnBehalfOf". Lowercase only the leading character to leave
        // acronyms like "URL" alone (defensive — Fern doesn't actually keep
        // acronym casing, but doing it this way mirrors Java conventions).
        const fieldName = getterSuffix[0].toLowerCase() + getterSuffix.slice(1);
        out.set(fieldName, jsonKey);
    }
    return out;
}

// Walk the staged-builder interfaces in declaration order, producing the
// list of required field names. Each non-_FinalStage interface declares
// exactly one fluent setter that returns the next stage; the setter's name
// IS the field name. _FinalStage carries optional setters which we ignore
// here.
export function parseJavaStagedBuilderOrder(source: string): string[] {
    const out: string[] = [];
    // Capture every `public interface XxxStage { ... }` block and inspect
    // its body. We restrict to interfaces that look like stages (PascalCase
    // ending in "Stage") to avoid picking up unrelated nested interfaces.
    // The non-greedy body match terminates at the first `}` — Fern's stage
    // interfaces only declare method signatures so they never contain
    // nested braces.
    const interfacePattern = /public\s+interface\s+(_?[A-Z]\w*Stage)\s*\{([\s\S]*?)\}/g;
    for (const m of source.matchAll(interfacePattern)) {
        const name = m[1];
        if (name === "_FinalStage") continue;
        const body = m[2];
        // First fluent setter: `<NextStage> fieldName(<args>);`
        const setter = body.match(/\b[A-Z_]\w*\s+(\w+)\s*\(/);
        if (setter) out.push(setter[1]);
    }
    return out;
}

// Walk `@JsonIgnore ... getFieldName()` pairs and produce a set of the
// corresponding field names. Such fields are typed on the request class
// but ship as headers (or are otherwise excluded from JSON serialization)
// rather than appearing in the body; the schema builder filters them out.
export function parseJavaJsonIgnoredFields(source: string): Set<string> {
    const out = new Set<string>();
    const pattern = /@JsonIgnore\s*[\s\S]*?public\s+\S[^()]*\s+get(\w+)\s*\(/g;
    for (const m of source.matchAll(pattern)) {
        const fieldName = m[1][0].toLowerCase() + m[1].slice(1);
        out.add(fieldName);
    }
    return out;
}

// One enum constant pair pulled from a Java enum body: the Java constant
// name (`ASSISTANT`) and its wire value (`assistant`, from the constructor
// arg). When Fern omits the constructor arg the two are the same string.
export interface JavaEnumConstant {
    constantName: string;
    wireValue: string;
}

// Pull `VALUE_NAME("wire-value")` or `VALUE_NAME` entries from an enum body
// as pairs. Fern emits `@JsonValue` getters that return the constructor
// arg, so the wire value differs from the constant name in lowercase-
// hyphenated APIs (`ASSISTANT("assistant")`). Schema consumers need both:
// the wire value goes on the manifest body for matching, the constant
// name is what a Java/TS renderer types into the SDK call.
export function parseJavaEnumValues(source: string): JavaEnumConstant[] {
    const enumBlock = source.match(/enum\s+\w+\s*[\s\S]*?\{([\s\S]*?)(?:;|\})/);
    if (!enumBlock) return [];
    const body = enumBlock[1];
    const out: JavaEnumConstant[] = [];
    // Match either `NAME("wire")` (Fern's pattern) or bare `NAME`.
    const pattern = /\b([A-Z][A-Z0-9_]*)\s*(?:\(\s*"([^"]+)"\s*\))?/g;
    for (const m of body.matchAll(pattern)) {
        // Filter out anything that's plainly not an enum constant (Java
        // keywords, modifier-y noise that survives the regex).
        if (m[1].length === 0) continue;
        out.push({ constantName: m[1], wireValue: m[2] ?? m[1] });
    }
    return out;
}

// Parse `import com.x.Y;` lines from a Java source file into a short→FQN
// map. Skips wildcards and static imports. Used by both class-file parsing
// and class-file lookup, so the regex lives in one place.
export function parseJavaImports(source: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of source.matchAll(/^\s*import\s+(?!static\s)([\w.]+)\s*;/gm)) {
        const fqn = m[1];
        const short = fqn.split(".").pop();
        if (short && short !== "*") out.set(short, fqn);
    }
    return out;
}

// Locate a request class file given the importer's file path and the type
// name pulled from the method signature. Mirrors resolveNestedClass's
// resolution rules so callers don't have to know the FQN ahead of time.
export function findJavaClassFile(rawClientFile: string, className: string): string | null {
    const imports = parseJavaImports(fs.readFileSync(rawClientFile, "utf-8"));
    const fqn = imports.get(className);
    const javaRoot = findJavaRoot(rawClientFile);
    if (fqn && javaRoot) {
        const candidate = path.join(javaRoot, fqn.replace(/\./g, "/") + ".java");
        if (fs.existsSync(candidate)) return candidate;
    }
    // Same-package fallback.
    const sibling = path.join(path.dirname(rawClientFile), className + ".java");
    return fs.existsSync(sibling) ? sibling : null;
}
