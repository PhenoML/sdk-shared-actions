#!/usr/bin/env node
// Verifies the bundled OpenAPI spec exists, is valid JSON, and was built
// from the same backend commit Fern recorded in metadata.json. Used as a
// pre-publish safety net in SDK CI: if bundle-openapi-spec didn't run for
// any reason, this fails the release rather than silently shipping a
// missing- or stale-spec package.

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
const metadataPath = path.resolve(
    repoRoot,
    process.env.PHENOML_OPENAPI_METADATA_PATH ?? ".fern/metadata.json",
);
const specPath = path.resolve(
    repoRoot,
    process.env.PHENOML_OPENAPI_SPEC_PATH ?? "openapi/openapi.json",
);

function fail(message) {
    console.error(`::error::${message}`);
    process.exit(1);
}

if (!fs.existsSync(specPath)) {
    fail(`${specPath} missing; bundle-openapi-spec workflow may not have run.`);
}

let spec;
try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
} catch (err) {
    fail(`${specPath} is not valid JSON: ${err.message}`);
}

const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const originCommit = metadata.originGitCommit;
const specVersion = spec?.info?.version;

if (specVersion !== originCommit) {
    fail(
        `Bundled spec version ${specVersion} does not match originGitCommit ${originCommit}.`,
    );
}

console.log(`OpenAPI spec OK (originGitCommit=${originCommit}).`);
