# sdk-shared-actions

Shared GitHub Actions for the Phenoml SDK repos.

- [`bundle-openapi-spec`](bundle-openapi-spec/README.md) — fetches the
  combined OpenAPI spec for an SDK's source commit and auto-commits it
  back to the calling PR.
- [`verify-openapi-spec`](verify-openapi-spec/README.md) — fails an SDK's
  publish job if the bundled spec is missing or stale.
