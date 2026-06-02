# bundle-openapi-spec

Composite action. Fetches the combined OpenAPI spec for an SDK's source
commit (Fern's `originGitCommit`) from the public `phenoml-openapi-specs`
GCS bucket and writes it to the working tree. Retries up to ~5 minutes to
absorb the race between Fern opening the SDK PR and the upstream
spec-publish workflow finishing.

This action **does not commit** — it only writes the file. Committing is
handled separately by [`commit-artifacts`](../commit-artifacts) so the spec
and other generated artifacts (e.g. `code-examples.json`) can be written back
in a single commit. Most callers should not invoke this action directly;
use the [`sync-fern-artifacts`](../.github/workflows/sync-fern-artifacts.yml)
reusable workflow, which runs bundle → extract → commit in one ordered run.

## Usage

Standalone (fetch + commit in one job):

```yaml
name: bundle-openapi-spec

on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - ".fern/metadata.json"

jobs:
  bundle:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    # Fork PRs can't push back to the head branch and we don't want to
    # leak tokens to forked code.
    if: github.event.pull_request.head.repo.full_name == github.repository
    env:
      HEAD_REF: ${{ github.event.pull_request.head.ref }}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ env.HEAD_REF }}
      - uses: PhenoML/sdk-shared-actions/bundle-openapi-spec@v1
      - uses: PhenoML/sdk-shared-actions/commit-artifacts@v1
        with:
          paths: openapi/openapi.json
          message: "chore: bundle OpenAPI spec"
```

See [`action.yml`](action.yml) for inputs.
