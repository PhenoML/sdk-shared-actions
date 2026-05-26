/**
 * Spec-driven code example extractor for Fern-generated SDKs.
 *
 * 1. Reads `openapi.json` — produces per-endpoint schemas + curated examples.
 * 2. Reads SDK source — produces per-endpoint SDK call metadata
 *    (method chain, method name, Java request-class name).
 * 3. Joins the two by (httpMethod, httpPath) and emits `code-examples.json`.
 *
 * Supports TypeScript, Python, and Java. Language is auto-detected from
 * `.fern/metadata.json` when present.
 *
 * Usage: bun run index.ts [--root /path/to/sdk] [--spec /path/to/openapi.json]
 *                          [--language typescript|python|java]
 */

import * as fs from "fs";
import * as path from "path";
import { detectLanguage, getPackageName } from "./language-detection";
import { buildManifest } from "./manifest";
import { createJavaParser } from "./parsers/java";
import { createPythonParser } from "./parsers/python";
import { createTypeScriptParser } from "./parsers/typescript";
import { loadSpec } from "./spec";
import type { FernMetadata, Language, LanguageParser } from "./types";
import { findPythonPackageDir } from "./utils";

const SUPPORTED_LANGUAGES: readonly Language[] = ["typescript", "python", "java"];

// Conventional spec-bundle paths per language (see bundle-openapi-spec).
// Override via --spec.
const DEFAULT_SPEC_PATHS: Record<Language, string[]> = {
    python: ["src/{pkg}/openapi/openapi.json", "openapi/openapi.json"],
    java: ["src/main/resources/openapi/openapi.json", "openapi/openapi.json"],
    typescript: ["openapi/openapi.json"],
};

interface Args {
    rootDir: string;
    specPath?: string;
    language?: Language;
}

function parseArgs(): Args {
    const args = process.argv.slice(2);
    const out: Args = { rootDir: process.cwd() };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--root" && args[i + 1]) {
            out.rootDir = args[++i];
        } else if (args[i] === "--spec" && args[i + 1]) {
            out.specPath = args[++i];
        } else if (args[i] === "--language" && args[i + 1]) {
            const value = args[++i];
            if (!SUPPORTED_LANGUAGES.includes(value as Language)) {
                throw new Error(
                    `Unsupported --language "${value}". Expected one of: ${SUPPORTED_LANGUAGES.join(", ")}`,
                );
            }
            out.language = value as Language;
        }
    }
    return out;
}

function resolveSpecPath(rootDir: string, language: Language): string {
    // Python's bundle path includes the package name (e.g. src/phenoml/openapi/...).
    const pkgDir = findPythonPackageDir(rootDir) ?? "phenoml";
    for (const candidate of DEFAULT_SPEC_PATHS[language]) {
        const full = path.join(rootDir, candidate.replace("{pkg}", pkgDir));
        if (fs.existsSync(full)) return full;
    }
    throw new Error(
        `No openapi.json found under ${rootDir}. Tried: ${DEFAULT_SPEC_PATHS[language].join(", ")}. ` +
        `Pass --spec to override.`,
    );
}

async function main() {
    const { rootDir, specPath: specPathOverride, language: languageOverride } = parseArgs();

    let language: Language;
    let metadata: FernMetadata;
    const metadataPath = path.join(rootDir, ".fern", "metadata.json");
    if (fs.existsSync(metadataPath)) {
        const detected = detectLanguage(rootDir);
        language = languageOverride ?? detected.language;
        metadata = detected.metadata;
    } else if (languageOverride) {
        language = languageOverride;
        metadata = {
            generatorName: `fernapi/fern-${language}-sdk`,
            sdkVersion: "unknown",
            originGitCommit: "unknown",
        };
        console.error(`WARNING: No .fern/metadata.json found, using --language ${language}`);
    } else {
        throw new Error("No .fern/metadata.json found and no --language specified");
    }

    const specPath = specPathOverride ?? resolveSpecPath(rootDir, language);
    console.error(`Language: ${language} (${metadata.generatorName})`);
    console.error(`Spec:     ${specPath}\n`);

    let parser: LanguageParser;
    switch (language) {
        case "typescript": parser = createTypeScriptParser(); break;
        case "python":     parser = createPythonParser(); break;
        case "java":       parser = createJavaParser(); break;
        default: {
            const exhaustive: never = language;
            throw new Error(`Unsupported language: ${exhaustive}`);
        }
    }

    console.error("Phase 1: Loading OpenAPI spec...");
    const specEndpoints = loadSpec(specPath);
    console.error(`  ${specEndpoints.length} endpoints\n`);

    console.error("Phase 2: Parsing SDK client source for method chains...");
    const endpointMappings = parser.parseEndpoints(rootDir);
    console.error(`  ${endpointMappings.length} mappings\n`);

    console.error("Phase 3: Building manifest...");
    const packageName = getPackageName(rootDir, language);
    const manifest = buildManifest(specEndpoints, endpointMappings, language, packageName, metadata);

    const outputPath = path.join(rootDir, "code-examples.json");
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n");
    console.error(`\nManifest written to ${outputPath}`);
}

// Run main() only when executed directly (not when imported, e.g. from tests).
if (import.meta.main) {
    main().catch((err) => {
        console.error("Error:", err);
        process.exit(1);
    });
}

// Exports for testing. Internal helpers — not a stable public API.
export { buildManifest } from "./manifest";
export { RENDER_RULES_BY_LANGUAGE, buildRenderSchema } from "./render-rules";
export { loadSpec } from "./spec";
export {
    camelToSnake,
    normalizePath,
    normalizePathParams,
    pascalCase,
    snakeToCamel,
} from "./utils";
export { createTypeScriptParser, tsExtractEndpoints } from "./parsers/typescript";
export { createPythonParser, pyDeriveMethodChain, pyExtractEndpoints } from "./parsers/python";
export {
    createJavaParser,
    javaBuildAccessorMap,
    javaDeriveMethodChain,
    javaExtractEndpoints,
} from "./parsers/java";
