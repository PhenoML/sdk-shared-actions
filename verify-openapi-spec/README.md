# verify-openapi-spec

Composite action. Pre-publish safety net: fails if the bundled OpenAPI spec
is missing, isn't valid JSON, or doesn't match the source commit recorded
in `.fern/metadata.json`. Use in each SDK's publish job so a missed
auto-commit can't silently ship a release without (or with the wrong) spec.

## Usage

In the publish job of each SDK's existing CI workflow:

```yaml
- uses: PhenoML/sdk-shared-actions/verify-openapi-spec@v1
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `metadata-path` | `.fern/metadata.json` | Path to Fern's metadata file. |
| `spec-path` | `openapi/openapi.json` | Path to the bundled spec. |
