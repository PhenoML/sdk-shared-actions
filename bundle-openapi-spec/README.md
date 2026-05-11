# bundle-openapi-spec

Composite action. Fetches the combined OpenAPI spec for an SDK's source
commit (Fern's `originGitCommit`) from the public `phenoml-openapi-specs`
GCS bucket and commits it back to the current branch if it changed.
Retries up to ~5 minutes to absorb the race between Fern opening the SDK
PR and the upstream spec-publish workflow finishing.

## Usage

In each SDK repo, add `.github/workflows/bundle-openapi-spec.yml`:

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
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.ref }}
      - uses: PhenoML/sdk-shared-actions/bundle-openapi-spec@v1
```

See [`action.yml`](action.yml) for inputs.
