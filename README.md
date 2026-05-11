# sdk-shared-actions

Shared GitHub Actions and reusable workflows for the Phenoml SDK repos
(`phenoml-ts-sdk`, `phenoml-python-sdk`, `phenoml-java-sdk`). The contents
are intentionally generic so the same logic can be wired into each
generated SDK without duplication.

## What's here

### `bundle-openapi-spec` reusable workflow

Auto-commits the combined OpenAPI spec for an SDK's source commit into the
calling PR. Fetches the spec from the public
[phenoml-openapi-specs](https://storage.googleapis.com/phenoml-openapi-specs/index.html)
GCS bucket keyed by `originGitCommit` from `.fern/metadata.json`. Retries
~5 minutes (exponential backoff) to absorb the occasional race between
Fern opening the SDK PR and the backend's spec-publish workflow finishing.

**Usage** — in each SDK repo, add `.github/workflows/bundle-openapi-spec.yml`:

```yaml
name: bundle-openapi-spec

on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - ".fern/metadata.json"

jobs:
  bundle:
    uses: PhenoML/sdk-shared-actions/.github/workflows/bundle-openapi-spec.yml@v1
```

Inputs (all optional):

| Input | Default | Description |
|---|---|---|
| `metadata-path` | `.fern/metadata.json` | Path to Fern's metadata file in the caller repo. |
| `output-path` | `openapi/openapi.json` | Where the spec should be written in the caller repo. |

### `verify-openapi-spec` composite action

Pre-publish safety net: fails if the bundled spec is missing, isn't valid
JSON, or doesn't match the source commit recorded in `metadata.json`. Use
in each SDK's publish job so a missed auto-commit can't silently ship a
release without (or with the wrong) spec.

**Usage** — in the publish job of each SDK's existing CI workflow:

```yaml
- uses: PhenoML/sdk-shared-actions/verify-openapi-spec@v1
```

Inputs (all optional):

| Input | Default | Description |
|---|---|---|
| `metadata-path` | `.fern/metadata.json` | Path to Fern's metadata file. |
| `spec-path` | `openapi/openapi.json` | Path to the bundled spec. |

## Versioning

Tag releases (`v1`, `v1.1`, …) and pin SDK callers to a tag. The reusable
workflow uses `github.workflow_sha` to pull its companion scripts from the
exact same commit, so a `@v1` pin gets a self-consistent bundle.

## Source-of-truth

The spec itself is generated and uploaded to GCS by
[`phenoml_backend`'s publish-openapi-specs workflow](https://github.com/PhenoML/phenoml_backend/blob/main/.github/workflows/publish-openapi-specs.yml).
This repo only handles fetching/bundling on the SDK side.
