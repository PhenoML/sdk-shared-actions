import * as fs from "fs";
import * as path from "path";

// First non-hidden subdirectory under `<root>/src/` — Fern Python SDKs put
// the package's code (and the bundled openapi.json) under this dir, but the
// name varies per project (e.g. `phenoml`).
export function findPythonPackageDir(rootDir: string): string | undefined {
    const srcDir = path.join(rootDir, "src");
    if (!fs.existsSync(srcDir)) return undefined;
    return fs.readdirSync(srcDir, { withFileTypes: true })
        .find((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))?.name;
}

export function findFiles(dir: string, pattern: RegExp): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    function walk(d: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (pattern.test(full)) results.push(full);
        }
    }
    walk(dir);
    return results.sort();
}

export function normalizePath(p: string): string {
    p = p.replace(/\\/g, "/");
    if (!p.startsWith("/")) p = "/" + p;
    if (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
    return p;
}

export function camelToSnake(str: string): string {
    return str
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase();
}

export function snakeToCamel(str: string): string {
    return str.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export function pascalCase(str: string): string {
    const camel = snakeToCamel(str.replace(/-/g, "_"));
    return camel.charAt(0).toUpperCase() + camel.slice(1);
}

export function screamingSnake(value: string): string {
    return value.replace(/-/g, "_").toUpperCase();
}

// Strips Fern's snake_case resource prefix from a `#/components/schemas/...`
// $refName, leaving the bare PascalCase class name a generator would emit.
// Multi-word resources matter: `fhir_provider_Provider` → `Provider` (not
// `provider_Provider`); the trailing PascalCase identifier is matched as a
// whole.
//
// Returns null when the name has multiple PascalCase segments separated by
// underscores (e.g. `agent_AgentChatRequest_Role`) — that pattern is ambiguous
// between a concatenated class (`AgentChatRequestRole`) and a nested namespace
// (`AgentChatRequest.Role`), and the spec alone can't disambiguate. Callers
// should skip emitting any identifier in that case rather than guess wrong.
//
// Returns the input unchanged when there's no `_PascalCase` suffix.
export function stripSchemaPrefix(refName: string): string | null {
    const pascalSegments = refName.match(/_[A-Z][A-Za-z0-9]*/g);
    if (pascalSegments && pascalSegments.length > 1) return null;
    const m = refName.match(/_([A-Z][A-Za-z0-9]*)$/);
    return m ? m[1] : refName;
}

// Normalize path parameter names in a URL template to snake_case.
// e.g., /construe/codes/{codeID} → /construe/codes/{code_id}
// Ensures consistent keys across TS/Python/Java manifests.
export function normalizePathParams(httpPath: string): string {
    return httpPath.replace(/\{(\w+)\}/g, (_, name) => `{${camelToSnake(name)}}`);
}
