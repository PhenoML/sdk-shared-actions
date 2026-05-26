import * as fs from "fs";
import * as path from "path";
import type { EndpointMapping, LanguageParser } from "../types";
import { findFiles, findPythonPackageDir, normalizePath, normalizePathParams } from "../utils";

export function createPythonParser(): LanguageParser {
    return {
        language: "python",
        parseEndpoints(rootDir: string): EndpointMapping[] {
            const pkgDir = findPythonPackageDir(rootDir);
            if (!pkgDir) {
                console.error("  WARNING: Could not find Python package directory");
                return [];
            }
            const pkgRoot = path.join(rootDir, "src", pkgDir);
            const endpoints: EndpointMapping[] = [];
            for (const file of findFiles(pkgRoot, /raw_client\.py$/)) {
                const fileEndpoints = pyExtractEndpoints(file, pkgRoot);
                endpoints.push(...fileEndpoints);
                console.error(`  ${path.relative(rootDir, file)}: ${fileEndpoints.length} endpoints`);
            }
            return endpoints;
        },
    };
}

export function pyExtractEndpoints(filePath: string, pkgRoot: string): EndpointMapping[] {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");

    const relativePath = path.relative(pkgRoot, filePath).replace(/\\/g, "/");
    const chain = pyDeriveMethodChain(relativePath);
    if (chain.includes("core")) return [];

    const endpoints: EndpointMapping[] = [];
    let currentMethod: string | null = null;
    // Only parse the sync `Raw*Client` class; the async twin would emit dupes.
    let inSyncClass = false;
    const seen = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^class\s+AsyncRaw\w+Client/.test(line)) { inSyncClass = false; continue; }
        if (/^class\s+Raw\w+Client/.test(line)) { inSyncClass = true; continue; }
        if (!inSyncClass) continue;

        const methodMatch = line.match(/^\s{4}def\s+(\w+)\s*\(/);
        if (methodMatch && !methodMatch[1].startsWith("_")) {
            currentMethod = methodMatch[1];
        }

        if (currentMethod && /self\._client_wrapper\.httpx_client\.(request|stream)\s*\(/.test(line)) {
            const httpPath = pyExtractRequestPath(lines, i);
            const httpMethod = pyExtractHttpMethod(lines, i);
            if (httpPath && httpMethod) {
                const normalized = normalizePathParams(normalizePath(httpPath));
                const key = `${httpMethod} ${normalized}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    endpoints.push({
                        httpMethod,
                        httpPath: normalized,
                        methodChain: [...chain, currentMethod],
                        methodName: currentMethod,
                    });
                }
            }
            currentMethod = null;
        }
    }
    return endpoints;
}

export function pyDeriveMethodChain(relativePath: string): string[] {
    // "cohort/raw_client.py" → ["cohort"]
    // "agent/resources/prompts/raw_client.py" → ["agent", "prompts"]
    const parts = relativePath.replace(/\/raw_client\.py$/, "").split("/");
    return parts.filter((p) => p !== "resources");
}

function pyExtractRequestPath(lines: string[], startLine: number): string | null {
    for (let i = startLine; i < Math.min(startLine + 5, lines.length); i++) {
        const line = lines[i].trim();
        // f-string template: `f"agent/{encode_path_param(id)}"`. Strip the
        // wrapper so the result is the bare `{id}` form the spec uses.
        const fMatch = line.match(/f"([^"]+)"/);
        if (fMatch) return fMatch[1].replace(/\{\w+\((\w+)\)\}/g, "{$1}");
        // Plain string positional arg: `"agent/create",` — but not `method="POST"`.
        const simpleMatch = line.match(/^"([^"]+)"\s*,/);
        if (simpleMatch && !line.includes("=")) return simpleMatch[1];
    }
    return null;
}

function pyExtractHttpMethod(lines: string[], startLine: number): string | null {
    for (let i = startLine; i < Math.min(startLine + 15, lines.length); i++) {
        const m = lines[i].match(/method\s*=\s*"(\w+)"/);
        if (m) return m[1];
    }
    return null;
}
