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

// Normalize path parameter names in a URL template to snake_case.
// e.g., /construe/codes/{codeID} → /construe/codes/{code_id}
// Ensures consistent keys across TS/Python/Java manifests.
export function normalizePathParams(httpPath: string): string {
    return httpPath.replace(/\{(\w+)\}/g, (_, name) => `{${camelToSnake(name)}}`);
}
