# extract-code-examples

Parses a Fern-generated SDK (TypeScript, Python, or Java) and writes a
`code-examples.json` manifest mapping `HTTP_METHOD path` keys to SDK call
sources, request bodies, and response bodies. The SDK language is
auto-detected from `.fern/metadata.json`.

## Inputs

| Name   | Default                | Description                              |
|--------|------------------------|------------------------------------------|
| `root` | `${{ github.workspace }}` | Root directory of the SDK repo to parse |

## Usage

```yaml
name: Extract Code Examples
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  extract:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.head_ref }}

      - uses: PhenoML/sdk-shared-actions/extract-code-examples@v1

      - name: Commit code-examples.json if changed
        run: |
          git add code-examples.json
          if ! git diff --cached --quiet -- code-examples.json; then
            git config user.name "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git commit -m "chore: update code-examples.json"
            git push
          fi
```

## Development

```sh
bun install
bun run test
```

Fixtures under `tests/fixtures/` are minimal slices of real SDK repos
(`phenoml-ts-sdk`, `phenoml-python-sdk`, `phenoml-java-sdk`) plus a
synthetic `java-multiline` fixture that exercises multi-line method
signature handling.
