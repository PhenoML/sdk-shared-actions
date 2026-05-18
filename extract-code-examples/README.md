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

## Manifest schema

The output `code-examples.json` has shape:

```jsonc
{
  "metadata": { "language": "java", "packageName": "...", "sdkVersion": "...", "specCommit": "...", "generatorName": "..." },
  "renderRules": { /* language-wide render constants — see below */ },
  "examples": {
    "POST /tools/cohort": {
      "httpMethod": "POST",
      "httpPath": "/tools/cohort",
      "sdkMethodChain": ["tools", "analyzeCohort"],
      "sdkMethodName": "analyzeCohort",
      "request": { "body": { /* wire JSON */ }, "sdkCallArgs": [ /* call args */ ] },
      "response": { "body": { /* wire JSON */ } },
      "sdkCallSource": "client.tools().analyzeCohort(...)",   // for display
      "render": { /* dynamic render schema — see below */ }
    }
  }
}
```

### Dynamic rendering

`renderRules` (per language) plus the per-example `render` field let a
consumer regenerate the SDK call for any user-provided body using one
language-agnostic algorithm. The algorithm is ~30 lines:

```
function renderCall(example, body, pathParams):
  // Render the body fields the user supplied, ordered by the schema.
  bodyStr = example.render.body
    ? example.render.body.fields
        .filter(f => f.jsonKey in body)
        .map(f => f.fieldTemplate.replace("{{value}}", renderValue(body[f.jsonKey], f)))
        .join(example.render.body.fieldSeparator)
    : ""

  // Substitute path/query params (positional) into their {{name}} placeholders.
  result = example.render.callTemplate
  for each p in example.render.params:
    result = result.replace("{{" + p.name + "}}", renderValue(pathParams[p.name], p))
  return result.replace("{{__body__}}", bodyStr)

function renderValue(value, field):
  if value === null:    return manifest.renderRules.nullLiteral
  if typeof value === "boolean": return value ? renderRules.trueLiteral : renderRules.falseLiteral
  if typeof value === "number":  return renderRules.numberLiteral.replace("{{value}}", value)
  if typeof value === "string":  return renderRules.stringLiteral.replace("{{value}}", jsonEscape(value))
  if isArray(value):
    items = value.map(v => renderValue(v, field.items)).join(renderRules.listSeparator)
    return renderRules.listLiteral.replace("{{items}}", items)
  if isObject(value):
    if field.nested:
      // Recurse: same algorithm with nested schema as the body
      return field.nested.fields
        .filter(nf => nf.jsonKey in value)
        .map(nf => nf.fieldTemplate.replace("{{value}}", renderValue(value[nf.jsonKey], nf)))
        .join(field.nested.fieldSeparator)
    // Fall back to language-native JSON-object rendering for untyped objects
```

#### `RenderSchema` fields

- `callTemplate` — call wrapper string containing `{{name}}` placeholders for path/query params and a `{{__body__}}` placeholder (omitted when there is no body).
- `params` — ordered list of path/query params (`{ name, kind }`). Each entry corresponds to a `{{name}}` placeholder in `callTemplate`.
- `body` — optional `{ fields, fieldSeparator }`. Fields are ordered (required first); each carries a `fieldTemplate` with a `{{value}}` placeholder.

#### `SchemaField` kinds

| `kind`    | extra fields            | rendering                                                                 |
|-----------|-------------------------|---------------------------------------------------------------------------|
| `string`  | —                       | Substitute the (JSON-escaped) string into `renderRules.stringLiteral`     |
| `number`  | —                       | Substitute the numeric text into `renderRules.numberLiteral`              |
| `boolean` | —                       | Use `renderRules.trueLiteral` / `falseLiteral`                            |
| `enum`    | `enumValues: string[]`  | Render as `string`; surface `enumValues` to UI for dropdowns              |
| `list`    | `items: SchemaField`    | Render each element via `items`, join with `listSeparator`, wrap via `listLiteral` |
| `object`  | `nested?: BodySchema`   | Recurse into `nested` if present; otherwise render as a JSON object literal |

#### Language differences encoded in `renderRules`

| Rule              | TypeScript     | Python                    | Java                       |
|-------------------|----------------|---------------------------|----------------------------|
| `trueLiteral`     | `true`         | `True`                    | `true`                     |
| `falseLiteral`    | `false`        | `False`                   | `false`                    |
| `nullLiteral`     | `null`         | `None`                    | `null`                     |
| `listLiteral`     | `[{{items}}]`  | `[{{items}}]`             | `Arrays.asList({{items}})` |

#### Language differences encoded in the per-example schema

| Construct           | TypeScript                                | Python                     | Java                                |
|---------------------|-------------------------------------------|----------------------------|-------------------------------------|
| Call wrapper        | `client.x.method({{path_param}}, { {{__body__}} })` | `client.x.method({{__body__}})` | `client.x().method({{path_param}}, RequestClass.builder(){{__body__}}.build())` |
| `fieldSeparator`    | `", "`                                    | `", "`                     | `""` (each field begins with `.`)   |
| `fieldTemplate`     | `"key": {{value}}`                        | `key={{value}}`            | `.setter({{value}})`                |
| Path params         | `params[]` (positional, before body)      | inside body schema (kwargs) | `params[]` (positional, before body) |

#### Schema completeness

The `render.body.fields` catalog is **spec-full** — it lists every field the
SDK type allows, regardless of whether the captured example body sets them.
Each parser reads the type definition on disk:

- **Java**: opens the request class file (`CohortRequest.java`), pulls every `private final` declaration plus its `@JsonProperty` / `@JsonIgnore` annotation.
- **Python**: parses the raw client method signature for all typed kwargs.
- **TypeScript**: parses the request interface (`CohortRequest.ts`) for all property signatures via the TS compiler API.

A field like summary's `template_id` that's only meaningful in certain
request modes will still appear in the catalog (with `required: false`),
so a consumer override can introduce it via add/remove rendering.

The `example.request.body` field, by contrast, only shows what the wire
test happened to populate — that's the *example*, not the schema.

#### Nested object recursion

| Kind                          | TypeScript | Python | Java |
|-------------------------------|------------|--------|------|
| `kind: "object"` (nested type) | `nested` schema if the type resolves to a sibling `<resource>/types/<Name>.ts` | Untyped (falls back to JSON-object literal rendering) | `nested` schema if the type resolves to a sibling class file |
| `kind: "list"` of objects     | `items.nested` populated when item type resolves | `items.kind: "object"` only (no nested schema) | `items.nested` populated when item type resolves |

Python nested-type resolution would require parsing the imported Pydantic
model file; consumers should fall back to language-native JSON-object
rendering for `kind: "object"` fields whose `nested` is absent.

## Development

```sh
bun install
bun run test
```

Fixtures under `tests/fixtures/` are minimal slices of real SDK repos
(`phenoml-ts-sdk`, `phenoml-python-sdk`, `phenoml-java-sdk`) plus
synthetic fixtures (`java-multiline`, `java-schema`) that exercise
specific parser behaviors.
