// Synthetic fixture: mirrors the Fern-emitted `JsonPatch` type alias
// (`type JsonPatch = JsonPatchOperation[]`). The parser must recognize
// this as an array alias and synthesize a list-typed passthrough body
// field so the consumer renders the example array verbatim.

import type * as phenoml from "../../../index.js";

export type JsonPatch = phenoml.agent.JsonPatchOperation[];
