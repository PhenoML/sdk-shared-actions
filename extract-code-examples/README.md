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
  if typeof value === "string":
    if field.kind === "enum" and field.enumConstants?.[value]:
      // Typed-enum languages (Java, TS) — use the language constant
      // expression so the rendered call typechecks.
      return field.enumConstants[value]
    return renderRules.stringLiteral.replace("{{value}}", jsonEscape(value))
  if isArray(value):
    items = value.map(v => renderValue(v, field.items)).join(renderRules.listSeparator)
    return renderRules.listLiteral.replace("{{items}}", items)
  if isObject(value):
    if field.nested:
      inner = field.nested.fields
        .filter(nf => nf.jsonKey in value)
        .map(nf => nf.fieldTemplate.replace("{{value}}", renderValue(value[nf.jsonKey], nf)))
        .join(field.nested.fieldSeparator)
      // Apply the language-specific envelope (Java: `Tag.builder(){{__body__}}.build()`;
      // TS: `{ {{__body__}} }`). The top-level `body` has no `wrap` —
      // its envelope is already in `callTemplate`.
      if field.nested.wrap:
        return field.nested.wrap.replace("{{__body__}}", inner)
      return inner
    // Fall back to language-native object rendering — see "Untyped object fallback" below
```

**Merge with the example body before rendering.** The algorithm above renders only the fields present in `body`; unspecified fields are omitted entirely. Consumers usually want "static example as base, override these keys" semantics — deep-merge the user's overrides into `example.request.body` before calling `renderCall`. Without the merge, naive consumers will produce calls missing required fields and may mistakenly think the schema is incomplete.

#### `RenderSchema` fields

- `callTemplate` — call wrapper string containing `{{name}}` placeholders for path/query params and a `{{__body__}}` placeholder (omitted when there is no body).
- `params` — ordered list of path/query params (`{ name, kind, enumValues? }`). Each entry corresponds to a `{{name}}` placeholder in `callTemplate`. `kind` uses the same `SchemaFieldKind` union as body fields, so an enum-typed path param can surface its allowed values via `enumValues` (today Fern emits scalar path args; the wider type future-proofs the schema).
- `body` — optional `{ fields, fieldSeparator, wrap? }`. Fields are ordered (required first); each carries a `fieldTemplate` with a `{{value}}` placeholder. The top-level body has no `wrap` (its envelope is in `callTemplate`); nested bodies (under a field's `nested` slot) carry `wrap` containing a `{{__body__}}` placeholder — Java emits `Tag.builder(){{__body__}}.build()`, TS emits `{ {{__body__}} }`.

#### `SchemaField` (and `ParamField`) kinds

Every entry — body field or path/query param — carries `kind` and `required`. The `required` flag is always present; it tells the consumer whether the field can be safely omitted (Java staged builders enforce this; TS/Python report it for fidelity). Path params are always required (the URL template can't be satisfied without them).

| `kind`    | extra fields            | rendering                                                                 |
|-----------|-------------------------|---------------------------------------------------------------------------|
| `string`  | —                       | Substitute the (JSON-escaped) string into `renderRules.stringLiteral`     |
| `number`  | —                       | Substitute the numeric text into `renderRules.numberLiteral`              |
| `boolean` | —                       | Use `renderRules.trueLiteral` / `falseLiteral`                            |
| `enum`    | `enumValues: string[]`, `enumConstants?: Record<wire, expr>` | When `enumConstants[value]` is set, emit that expression verbatim (e.g. `AgentRole.ASSISTANT`); otherwise fall back to `string` rendering. Always surface `enumValues` to UI for dropdowns |
| `list`    | `items: SchemaField`    | Render each element via `items`, join with `listSeparator`, wrap via `listLiteral` |
| `object`  | `nested?: BodySchema`   | Recurse into `nested` if present; see "Untyped object fallback" below     |

#### Untyped object fallback

When `kind === "object"` and `nested` is absent, the SDK type couldn't be resolved. Behavior:

- **TS / Python**: render as a language-native JSON object literal — `{ key: value, ... }` for TS, `{"key": value, ...}` for Python. Both languages accept this in places where the type would have specified a typed object.
- **Java**: undefined. Java's typed builders don't accept JSON-object literals; in practice `nested` is always populated for fields the schema knows about, so this case shouldn't occur on a well-formed manifest. Consumers should treat an unresolved Java `object` field as a schema-extraction gap and either skip the field or fall back to the example's `request.body` value verbatim.

#### `renderRules` reference

Every key in `renderRules` is required so the consumer's `renderValue` algorithm runs without nil checks.

| Key             | TypeScript      | Python           | Java                          |
|-----------------|-----------------|------------------|-------------------------------|
| `stringLiteral` | `"{{value}}"`   | `"{{value}}"`    | `"{{value}}"`                 |
| `numberLiteral` | `{{value}}`     | `{{value}}`      | `{{value}}`                   |
| `trueLiteral`   | `true`          | `True`           | `true`                        |
| `falseLiteral`  | `false`         | `False`          | `false`                       |
| `nullLiteral`   | `null`          | `None`           | `null`                        |
| `listLiteral`   | `[{{items}}]`   | `[{{items}}]`    | `Arrays.asList({{items}})`    |
| `listSeparator` | `", "`          | `", "`           | `", "`                        |

`{{value}}` is replaced with the rendered child literal; `{{items}}` is replaced with the list elements pre-joined by `listSeparator`.

**String escaping**: the consumer is responsible for escaping the string's interior before substituting into `stringLiteral`. JSON escaping (`\n`, `\t`, `\"`, `\\`, `\uXXXX`) is a safe lowest common denominator across all three languages — Java string literals accept the same escape sequences as JSON. The `stringLiteral` template supplies the surrounding quotes.

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

#### Per-language `enumConstants` population

| Language    | Populated?         | Shape                                                                  |
|-------------|--------------------|------------------------------------------------------------------------|
| Java        | Always for enums   | `{wire: "EnumName.CONSTANT"}` (e.g. `AgentRole.ASSISTANT`)             |
| TypeScript  | Always for enums   | `{wire: "Namespace.Type.Key"}` (e.g. `AgentChatRequest.Role.Assistant`)|
| Python      | Absent             | Wire-string substitution into `stringLiteral` is the correct render — Pydantic accepts the raw value |

## Development

```sh
bun install
bun run test
```

Fixtures under `tests/fixtures/` are minimal slices of real SDK repos
(`phenoml-ts-sdk`, `phenoml-python-sdk`, `phenoml-java-sdk`) plus
synthetic fixtures (`java-multiline`, `java-schema`) that exercise
specific parser behaviors.
