import type {
    CodeExample,
    EndpointMapping,
    FernMetadata,
    Language,
    Manifest,
    SpecEndpoint,
} from "./types";
import { RENDER_RULES_BY_LANGUAGE, buildRenderSchema } from "./render-rules";

export function buildManifest(
    specEndpoints: SpecEndpoint[],
    endpointMappings: EndpointMapping[],
    language: Language,
    packageName: string,
    metadata: FernMetadata,
): Manifest {
    const mappingByKey = new Map<string, EndpointMapping>();
    for (const ep of endpointMappings) {
        mappingByKey.set(`${ep.httpMethod} ${ep.httpPath}`, ep);
    }

    const manifest: Manifest = {
        metadata: {
            language,
            packageName,
            sdkVersion: metadata.sdkVersion,
            specCommit: metadata.originGitCommit || "unknown",
            generatorName: metadata.generatorName,
        },
        renderRules: RENDER_RULES_BY_LANGUAGE[language],
        examples: {},
    };

    let matched = 0;
    let unmatched = 0;
    const specKeys = new Set<string>();
    for (const spec of specEndpoints) {
        const key = `${spec.httpMethod} ${spec.httpPath}`;
        specKeys.add(key);
        const mapping = mappingByKey.get(key);
        if (!mapping) {
            console.error(`  WARNING: spec endpoint ${key} has no SDK-side mapping`);
            unmatched++;
            continue;
        }

        const render = buildRenderSchema(spec, mapping, language);
        const example: CodeExample = {
            httpMethod: spec.httpMethod,
            httpPath: spec.httpPath,
            request: { body: spec.requestExample ?? null },
            response: spec.isStreaming
                ? { body: null, streaming: true }
                : { body: spec.responseExample ?? null },
            render,
        };
        manifest.examples[key] = example;
        matched++;
    }

    // Surface mappings the spec doesn't cover — usually a sign the SDK was
    // regenerated against a newer spec than what's bundled here.
    const orphanMappings = endpointMappings.filter((m) => !specKeys.has(`${m.httpMethod} ${m.httpPath}`));
    if (orphanMappings.length > 0) {
        console.error(`\n  SDK endpoints with no spec entry:`);
        for (const m of orphanMappings) {
            console.error(`    ${m.httpMethod} ${m.httpPath} (${m.methodChain.join(".")})`);
        }
    }

    console.error(`\n  Matched: ${matched}, Unmatched: ${unmatched}`);
    console.error(`  Coverage: ${matched}/${specEndpoints.length} spec endpoints have SDK mappings`);
    return manifest;
}
