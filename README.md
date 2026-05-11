# sdk-shared-actions

Shared GitHub Actions for the Phenoml SDK repos. Each top-level directory is
a composite action that SDK repos can invoke via `uses:`.

## Actions

- [`bundle-openapi-spec`](bundle-openapi-spec/README.md) — fetches the
  combined OpenAPI spec for an SDK's source commit and auto-commits it
  back to the calling PR.
- [`verify-openapi-spec`](verify-openapi-spec/README.md) — fails an SDK's
  publish job if the bundled spec is missing or stale.
- [`extract-code-examples`](extract-code-examples/README.md) — parses a
  Fern-generated SDK and writes a `code-examples.json` manifest mapping
  HTTP method + path to SDK call source, request body, and response body.

## Development

Each action's tests live under `<action>/tests/` and run via `bun test`.
The `Test` CI workflow runs all actions' suites as a matrix.

```sh
cd extract-code-examples
bun install
bun run test
```
