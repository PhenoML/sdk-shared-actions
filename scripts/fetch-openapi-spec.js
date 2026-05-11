#!/usr/bin/env node
// Fetches the combined OpenAPI spec for an SDK's source commit from the
// public phenoml-openapi-specs GCS bucket.
//
// Reads originGitCommit from $PHENOML_OPENAPI_METADATA_PATH (typically
// .fern/metadata.json) and writes the spec to $PHENOML_OPENAPI_OUTPUT_PATH.
// Both paths resolve relative to $GITHUB_WORKSPACE (or cwd) so the script
// runs the same locally and in CI regardless of where it's checked out.
//
// Retries are needed because Fern can occasionally open an SDK PR before
// the backend's upload-to-GCS workflow finishes for the same commit.

const fs = require("node:fs");
const path = require("node:path");

const BUCKET_BASE =
    "https://storage.googleapis.com/phenoml-openapi-specs/combined";

const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
const metadataPath = path.resolve(
    repoRoot,
    process.env.PHENOML_OPENAPI_METADATA_PATH ?? ".fern/metadata.json",
);
const outputPath = path.resolve(
    repoRoot,
    process.env.PHENOML_OPENAPI_OUTPUT_PATH ?? "openapi/openapi.json",
);

// Total ~5 min: enough for the typical GCS-upload-vs-Fern-PR race, short
// enough to surface real upstream failures quickly.
const MAX_ATTEMPTS = 10;
const INITIAL_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSpec(commit) {
    const url = `${BUCKET_BASE}/specs-${commit}.json`;
    let delay = INITIAL_DELAY_MS;
    let lastFailure = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return Buffer.from(await response.arrayBuffer());
            }
            // 404 is the expected race signal (backend's GCS upload still in
            // flight when Fern opened the PR); other statuses are unusual but
            // also worth retrying transiently.
            lastFailure = `HTTP ${response.status} ${response.statusText}`;
        } catch (err) {
            lastFailure = `network error: ${err.message}`;
        }

        if (attempt === MAX_ATTEMPTS) {
            throw new Error(
                `Failed to fetch ${url} after ${MAX_ATTEMPTS} attempts: ${lastFailure}`,
            );
        }
        console.log(
            `Attempt ${attempt}/${MAX_ATTEMPTS} got ${lastFailure}; retrying in ${delay / 1000}s...`,
        );
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
}

async function main() {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const commit = metadata.originGitCommit;
    if (!commit) {
        throw new Error(`originGitCommit missing from ${metadataPath}`);
    }
    console.log(`Fetching OpenAPI spec for originGitCommit=${commit}`);

    const body = await fetchSpec(commit);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, body);

    console.log(`Wrote ${outputPath} (${body.length} bytes)`);
}

main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
});
