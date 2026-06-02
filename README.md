# sdk-shared-actions

Shared GitHub Actions and reusable workflows for the Phenoml SDK repos.

## Actions

- [`bundle-openapi-spec`](bundle-openapi-spec/README.md) — fetches the
  combined OpenAPI spec for an SDK's source commit and writes it to the
  working tree.
- [`extract-code-examples`](extract-code-examples/README.md) — parses a
  Fern-generated SDK and writes a `code-examples.json` manifest mapping
  HTTP method + path to SDK call source, request body, and response body.
- [`commit-artifacts`](commit-artifacts/README.md) — stages, commits, and
  pushes the given files back to the PR branch (rebasing + retrying on
  concurrent pushes). The shared "write it back" step for the generator
  actions above, which only produce files.
- [`verify-openapi-spec`](verify-openapi-spec/README.md) — fails an SDK's
  publish job if the bundled spec is missing or stale.

## Reusable workflows

- [`sync-fern-artifacts`](.github/workflows/sync-fern-artifacts.yml) — runs
  bundle → extract → commit in a single ordered run, so the bundled spec and
  its derived `code-examples.json` are always generated together and land in
  one commit. SDK repos call this instead of separate bundle/extract
  workflows, which could race (extract reading a stale spec) and never
  self-heal. See the workflow header for inputs.
