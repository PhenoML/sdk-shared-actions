# verify-openapi-spec

Composite action. Pre-publish safety net: fails an SDK's release if the
bundled OpenAPI spec is missing, malformed, or doesn't match the source
commit Fern recorded in `.fern/metadata.json`.

## Usage

In the publish job of each SDK's existing CI workflow:

```yaml
- uses: PhenoML/sdk-shared-actions/verify-openapi-spec@v1
```

See [`action.yml`](action.yml) for inputs.
