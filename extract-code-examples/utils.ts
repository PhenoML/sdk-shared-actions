import * as fs from "fs";
import * as path from "path";

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

/**
 * Normalize path parameter names in a URL template to snake_case.
 * e.g., /construe/codes/{codeID} → /construe/codes/{code_id}
 * Ensures consistent keys across TS/Python/Java manifests.
 */
export function normalizePathParams(httpPath: string): string {
    return httpPath.replace(/\{(\w+)\}/g, (_, name) => `{${camelToSnake(name)}}`);
}

export function isBalancedParens(str: string): boolean {
    let depth = 0;
    for (const ch of str) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (depth < 0) return false;
    }
    return depth === 0;
}

// Naive about strings/comments — same trade-off as isBalancedParens, which
// is fine for Fern-generated test bodies (no parens-in-strings in args).
// Drops trailing punctuation when the SDK call appears in a compound
// statement like `for _ in client.foo(...):` — the regex captures the `:`
// from the `for` header along with the call.
export function truncateAfterMatchingParen(s: string): string {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")" && --depth === 0) return s.slice(0, i + 1);
    }
    return s;
}

// True if `concretePath` matches `templatePath` segment-by-segment, treating
// any "{name}" segment in the template as a wildcard. e.g. "/agent/{id}"
// matches "/agent/abc123".
export function pathMatchesTemplate(templatePath: string, concretePath: string): boolean {
    const tmpl = templatePath.split("/");
    const concrete = concretePath.split("/");
    if (tmpl.length !== concrete.length) return false;
    for (let i = 0; i < tmpl.length; i++) {
        if (tmpl[i].startsWith("{") && tmpl[i].endsWith("}")) continue;
        if (tmpl[i] !== concrete[i]) return false;
    }
    return true;
}
