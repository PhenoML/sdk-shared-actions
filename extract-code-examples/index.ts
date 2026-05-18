/**
 * Multi-language code example extractor for Fern-generated SDKs.
 *
 * Extracts structured code examples by:
 * 1. Parsing client source files → endpoint-to-SDK-method mapping
 * 2. Parsing wire test files → example request/response data
 * 3. Combining into a code-examples.json manifest keyed by HTTP method + path
 *
 * Supports TypeScript, Python, and Java SDKs. Language is auto-detected
 * from .fern/metadata.json.
 *
 * Usage: bun run index.ts [--root /path/to/sdk] [--language typescript|python|java]
 */

import * as fs from "fs";
import * as path from "path";
import { detectLanguage, getPackageName } from "./language-detection";
import { buildManifest } from "./manifest";
import { createJavaParser } from "./parsers/java";
import { createPythonParser } from "./parsers/python";
import { createTypeScriptParser } from "./parsers/typescript";
import type { FernMetadata, Language, LanguageParser } from "./types";

const SUPPORTED_LANGUAGES: readonly Language[] = ["typescript", "python", "java"];

function parseArgs(): { rootDir: string; language?: Language } {
    const args = process.argv.slice(2);
    let rootDir = process.cwd();
    let language: Language | undefined;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--root" && args[i + 1]) {
            rootDir = args[++i];
        } else if (args[i] === "--language" && args[i + 1]) {
            const value = args[++i];
            if (!SUPPORTED_LANGUAGES.includes(value as Language)) {
                throw new Error(
                    `Unsupported --language "${value}". Expected one of: ${SUPPORTED_LANGUAGES.join(", ")}`,
                );
            }
            language = value as Language;
        }
    }
    return { rootDir, language };
}

async function main() {
    const { rootDir, language: languageOverride } = parseArgs();

    let language: Language;
    let metadata: FernMetadata;

    const metadataPath = path.join(rootDir, ".fern", "metadata.json");
    if (fs.existsSync(metadataPath)) {
        const detected = detectLanguage(rootDir);
        language = languageOverride ?? detected.language;
        metadata = detected.metadata;
    } else if (languageOverride) {
        language = languageOverride;
        metadata = { generatorName: `fernapi/fern-${language}-sdk`, sdkVersion: "unknown", originGitCommit: "unknown" };
        console.error(`WARNING: No .fern/metadata.json found, using --language ${language}`);
    } else {
        throw new Error("No .fern/metadata.json found and no --language specified");
    }

    console.error(`Language: ${language} (${metadata.generatorName})\n`);

    let parser: LanguageParser;
    switch (language) {
        case "typescript": parser = createTypeScriptParser(); break;
        case "python": parser = createPythonParser(); break;
        case "java": parser = createJavaParser(); break;
        default: {
            const exhaustive: never = language;
            throw new Error(`Unsupported language: ${exhaustive}`);
        }
    }

    // Phase 1: Extract endpoint mappings from client source
    console.error("Phase 1: Parsing client source files...");
    const allEndpoints = parser.parseEndpoints(rootDir);
    console.error(`  Total: ${allEndpoints.length} endpoints\n`);

    // Phase 2: Extract examples from wire tests
    console.error("Phase 2: Parsing wire test files...");
    const allExamples = parser.parseTestExamples(rootDir);
    console.error(`  Total: ${allExamples.length} examples\n`);

    // Phase 3: Build manifest
    console.error("Phase 3: Building manifest...");
    const packageName = getPackageName(rootDir, language);
    const manifest = buildManifest(allEndpoints, allExamples, language, packageName, metadata);

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
export { buildManifest, deriveBodyFromKwargs, findTemplateMatch } from "./manifest";
export {
    camelToSnake,
    isBalancedParens,
    normalizePath,
    normalizePathParams,
    truncateAfterMatchingParen,
} from "./utils";
export { createTypeScriptParser, tsExtractEndpoints, tsExtractTestExamples } from "./parsers/typescript";
export {
    buildTsRenderSchema,
    tsExtractMethodSignatureInfo,
    tsInferKind,
    tsParseRequestInterface,
    tsResolveRequestInterfacePath,
} from "./parsers/typescript-schema";
export {
    createPythonParser,
    pyDeriveMethodChain,
    pyExtractBodyParamMap,
    pyExtractBodyShape,
    pyExtractEndpoints,
    pyExtractHttpMethod,
    pyExtractRequestPath,
    pyExtractTestExamples,
    pyParseKwargs,
} from "./parsers/python";
export {
    buildPythonRenderSchema,
    pyExtractEnumValues,
    pyExtractHeaderKwargs,
    pyExtractMethodKwargs,
    pyInferKind,
    pyParseSignatureKwargs,
    pyStripOptional,
    pyUnwrapList,
} from "./parsers/python-schema";
export {
    buildJavaRenderSchema,
    createJavaParser,
    javaBuildAccessorMap,
    javaClassifySignatureParams,
    javaCountBraceDelta,
    javaDeriveMethodChain,
    javaExtractConcatenatedString,
    javaExtractEndpoints,
    javaExtractSetBody,
    javaExtractTestExamples,
    javaParseSignatureParams,
    javaUnescape,
} from "./parsers/java";
export {
    buildJavaBodySchema,
    findJavaClassFile,
    inferKind as inferJavaKind,
    parseJavaClass,
    parseJavaEnumValues,
    parseJavaFieldDeclarations,
    parseJavaJsonIgnoredFields,
    parseJavaJsonProperties,
    parseJavaStagedBuilderOrder,
} from "./parsers/java-request-class";
