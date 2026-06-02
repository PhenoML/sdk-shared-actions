# extract-code-examples

Reads a Fern-generated SDK's bundled OpenAPI spec (`openapi.json`) and the
SDK source itself, then writes a `code-examples.json` manifest mapping
`HTTP_METHOD path` keys to per-endpoint request/response examples plus a
dynamic-render schema for the SDK call. Supports TypeScript, Python, and
Java. The language is auto-detected from `.fern/metadata.json` when
present (and overridable via `--language`).

## Architecture

The action pulls each piece of information from the source that's
authoritative for it:

- **Schemas, request/response examples, path/query parameters,
  streaming flag** — from `openapi.json` (committed alongside the SDK by
  the [`bundle-openapi-spec`](../bundle-openapi-spec) action).
- **SDK method chain, method name, Java request-class name, TypeScript
  request-body wrapper key** — from the generated SDK source (per-language
  parsers under `parsers/`).

The two halves are joined by `(HTTP method, path)` and rendered through
language-specific templates in `render-rules.ts`.

## Inputs

| Name   | Default                                | Description                                                                  |
|--------|----------------------------------------|------------------------------------------------------------------------------|
| `root` | `${{ github.workspace }}`              | Root directory of the SDK repo to parse.                                     |
| `spec` | (per-language convention under `root`) | Path to the bundled `openapi.json`. Pass to override the default location.   |

Default spec paths (matching [`bundle-openapi-spec`](../bundle-openapi-spec)):

- Python: `src/{pkg}/openapi/openapi.json`
- Java: `src/main/resources/openapi/openapi.json`
- TypeScript: `openapi/openapi.json`

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
```

The action commits `code-examples.json` and pushes it back to the PR
branch when the manifest changes (retrying on non-fast-forward so it
co-exists with anything else — another workflow, a human — pushing to
the same branch concurrently). The caller must check out the PR branch
with `contents: write` permission.

## Manifest schema

```jsonc
{
  "metadata": { "language": "java", "packageName": "...", "sdkVersion": "...", "specCommit": "...", "generatorName": "..." },
  "renderRules": { /* language-wide render constants — see below */ },
  "examples": {
    "POST /agent/create": {
      "httpMethod": "POST",
      "httpPath": "/agent/create",
      "request": { "body": { /* spec example — also the merge base for renderCall */ } },
      "response": { "body": { /* spec example */ }, "streaming": false },
      "render": { /* dynamic render schema — see below */ }
    }
  }
}
```

The SDK method chain, method name, and call args used to live on each
example; they're all derivable from `render` and have been removed.
Recompose them by running `renderCall(example, example.request.body, {})`
if a human-readable form is needed.

### Streaming endpoints

`response.streaming === true` marks SSE / streaming endpoints, detected
from the spec's `text/event-stream` response content type. When set,
`response.body` is **always `null`** — the manifest does NOT carry an
example event chunk or accumulated result. Consumers rendering a
streaming example UI should treat `streaming: true` as the signal to
switch presentation (e.g. show an "event stream" badge).

### Dynamic rendering

`renderRules` (per language) plus the per-example `render` field let a
consumer regenerate the SDK call for any user-provided body using one
language-agnostic algorithm. The algorithm is ~30 lines:

```
function renderCall(example, body, pathParams):
  // Render the body fields the user supplied, ordered by the schema.
  // `passthroughBody`: the field's value is the entire `body`, not
  // `body[jsonKey]` — used for endpoints whose wire body is a top-level
  // JSON Patch array rather than an object.
  bodyStr = example.render.body
    ? example.render.body.fields
        .filter(f => f.passthroughBody || f.jsonKey in body)
        .map(f => {
          const value = f.passthroughBody ? body : body[f.jsonKey]
          return f.fieldTemplate.replace("{{value}}", renderValue(value, f))
        })
        .join(example.render.body.fieldSeparator)
    : ""

  // Substitute path/query params into their {{name}} placeholders.
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

**Merge with the example body before rendering.** The algorithm above renders only the fields present in `body`; unspecified fields are omitted entirely. Consumers usually want "static example as base, override these keys" semantics — deep-merge the user's overrides into `example.request.body` before calling `renderCall`. Without the merge, naive consumers will produce calls missing required fields.

#### `RenderSchema` fields

- `callTemplate` — call wrapper string containing `{{name}}` placeholders for path params and a `{{__body__}}` placeholder (omitted when there is no body).
- `params` — ordered list of path params (`{ name, kind, enumValues? }`). Each entry corresponds to a `{{name}}` placeholder in `callTemplate`. `kind` uses the same `SchemaFieldKind` union as body fields.
- `body` — optional `{ fields, fieldSeparator, wrap? }`. Fields are ordered (required first, then optional in spec declaration order). Each carries a `fieldTemplate` with a `{{value}}` placeholder. The top-level body has no `wrap` (its envelope is in `callTemplate`); nested bodies (under a field's `nested` slot) carry `wrap` containing a `{{__body__}}` placeholder — Java emits `Tag.builder(){{__body__}}.build()`.

Query parameters are folded into `body.fields` so the consumer renders them as kwargs alongside body fields. They keep their natural `required: false` flag when the spec marks them optional.

#### `SchemaField` (and `ParamField`) kinds

| `kind`    | extra fields                                              | rendering                                                                 |
|-----------|-----------------------------------------------------------|---------------------------------------------------------------------------|
| `string`  | —                                                         | Substitute the (JSON-escaped) string into `renderRules.stringLiteral`     |
| `number`  | —                                                         | Substitute the numeric text into `renderRules.numberLiteral`              |
| `boolean` | —                                                         | Use `renderRules.trueLiteral` / `falseLiteral`                            |
| `enum`    | `enumValues: string[]`, `enumConstants?: Record<wire, expr>` | When `enumConstants[value]` is set, emit that expression verbatim (e.g. `AgentRole.ASSISTANT`); otherwise fall back to `string` rendering. Always surface `enumValues` to UI for dropdowns |
| `list`    | `items: SchemaField`                                      | Render each element via `items`, join with `listSeparator`, wrap via `listLiteral` |
| `object`  | `nested?: BodySchema`                                     | Recurse into `nested` if present; otherwise emit a language-native JSON object literal |

#### `renderRules` reference

| Key             | TypeScript      | Python           | Java                          |
|-----------------|-----------------|------------------|-------------------------------|
| `stringLiteral` | `"{{value}}"`   | `"{{value}}"`    | `"{{value}}"`                 |
| `numberLiteral` | `{{value}}`     | `{{value}}`      | `{{value}}`                   |
| `trueLiteral`   | `true`          | `True`           | `true`                        |
| `falseLiteral`  | `false`         | `False`          | `false`                       |
| `nullLiteral`   | `null`          | `None`           | `null`                        |
| `listLiteral`   | `[{{items}}]`   | `[{{items}}]`    | `Arrays.asList({{items}})`    |
| `listSeparator` | `", "`          | `", "`           | `", "`                        |

**String escaping**: the consumer is responsible for escaping the string's interior before substituting into `stringLiteral`. JSON escaping (`\n`, `\t`, `\"`, `\\`, `\uXXXX`) is a safe lowest common denominator across all three languages. The `stringLiteral` template supplies the surrounding quotes.

#### Language differences encoded in the per-example schema

| Construct           | TypeScript                                | Python                          | Java                                |
|---------------------|-------------------------------------------|---------------------------------|-------------------------------------|
| Call wrapper        | `client.x.method({{id}}, { {{__body__}} })` | `client.x.method(id={{id}}, {{__body__}})` | `client.x().method({{id}}, ReqClass.builder(){{__body__}}.build())` |
| `fieldSeparator`    | `", "`                                    | `", "`                          | `""` (each field begins with `.`)   |
| `fieldTemplate`     | `"key": {{value}}`                        | `key={{value}}`                 | `.setter({{value}})`                |
| Path params         | `params[]` (positional)                   | `params[]` (kwarg in callTemplate) | `params[]` (positional)         |

#### Passthrough body fields

Some endpoints' wire body is a non-object value (a top-level JSON Patch
array, for example). The schema field for the body carries
`passthroughBody: true` so the consumer's renderer sources the value
from `body` directly rather than `body[jsonKey]`. The flag is absent on
every other field.

The flag is set when the spec's request schema isn't an object — a
type alias to an array, a oneOf without a wrapping object, etc. The
renderer emits a single synthetic field (`jsonKey: ""`,
`fieldTemplate: "{{value}}"`, `passthroughBody: true`) plus the
appropriate `kind` (`list` with `items` resolved, or `object`).

`callTemplate` skips the `{ {{__body__}} }` wrapping in this branch
(TypeScript) — the rendered body literal (`[...]` or `{...}`) supplies
its own delimiters.

#### TypeScript request-body wrapper

Fern's TypeScript SDK normally inlines the request body straight into the
request object — `client.agent.create({ name: "..." })`. But when an
endpoint *also* carries header or query members, the body can't share that
object's namespace, so Fern nests it under a dedicated key (conventionally
`body`) alongside them:

```ts
client.fhir.create(fhirProviderId, fhirPath, { body: { resourceType: "Patient" } })
```

The wire body schema (`application/fhir+json`, a JSON Patch array, …) gives
no hint of this — it's a pure codegen decision — so the TS parser reads it
off the method source. Fern's `__method` impl destructures the request:

- `body: request` (whole request is the wire body) → **inlined**, no wrapper.
- `const { …headers, body: _body } = request` (property binding) → wrapper
  key is `body`.
- `const { …headers, ..._body } = request` (rest binding — the body fields
  were spread in flat) → **inlined**, no wrapper.

When a wrapper key is found it's recorded as `EndpointMapping.bodyWrapperKey`,
and the renderer nests the body slot under it: passthrough bodies become
`{ "body": [...] }` / `{ "body": {...} }`, inlined object bodies become
`{ "body": { "key": value } }`. The `body.fields` catalog and
`example.request.body` stay **unwrapped** — they describe the payload itself;
the wrapper is purely the call-site envelope, encoded in `callTemplate`. This
is a TypeScript-only concern (Python inlines the fields as kwargs; Java wraps
via its request-class builder).

#### Schema completeness

The `render.body.fields` catalog is **spec-full** — it lists every field
the OpenAPI request schema declares, regardless of whether the captured
example body sets them. Required fields come first, then optional in
spec declaration order.

The `example.request.body` field, by contrast, only carries what the
spec's curated example happened to populate.

#### Per-language `enumConstants` population

| Language    | Populated?         | Shape                                                                  |
|-------------|--------------------|------------------------------------------------------------------------|
| Java        | Always for enums   | `{wire: "EnumName.CONSTANT"}` (e.g. `AgentRole.ASSISTANT`)             |
| TypeScript  | Always for enums   | `{wire: "Namespace.PascalKey"}` (e.g. `AgentRole.Assistant`)           |
| Python      | Absent             | Wire-string substitution into `stringLiteral` is the correct render — Pydantic accepts the raw value |

## Development

```sh
bun install
bun run test
```

Fixtures under `tests/fixtures/` are minimal: a shared `openapi-shared.json`
plus three language-specific SDK slices (`python/`, `typescript/`, `java/`)
that mirror the bits of Fern-generated SDK shape the slim chain
extractors look for.
