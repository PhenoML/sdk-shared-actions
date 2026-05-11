# sdk-shared-actions

Shared GitHub Actions and reusable workflows for the Phenoml SDK repos
(`phenoml-ts-sdk`, `phenoml-python-sdk`, `phenoml-java-sdk`). The contents
are intentionally generic so the same logic can be wired into each
generated SDK without duplication.

## Contents

- [`bundle-openapi-spec`](.github/workflows/bundle-openapi-spec.yml) —
  reusable workflow that auto-commits the combined OpenAPI spec for an
  SDK's source commit into the calling PR. See the header comment in the
  workflow file for usage.
- [`verify-openapi-spec`](verify-openapi-spec/) — composite action that
  fails an SDK's publish job if the bundled spec is missing or stale. See
  [`verify-openapi-spec/README.md`](verify-openapi-spec/README.md) for
  usage.

## Versioning

Tag releases (`v1`, `v1.1`, …) and pin SDK callers to a tag.

## Source-of-truth

The spec itself is generated and uploaded to GCS by
[`phenoml_backend`'s publish-openapi-specs workflow](https://github.com/PhenoML/phenoml_backend/blob/main/.github/workflows/publish-openapi-specs.yml).
This repo only handles fetching/bundling on the SDK side.
