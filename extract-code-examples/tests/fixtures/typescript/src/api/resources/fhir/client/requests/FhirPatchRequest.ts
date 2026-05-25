// Synthetic fixture: mirrors the real Fern-generated FhirPatchRequest
// interface. The `body` property is the JSON Patch array that ships as
// the wire body; the two `X-Phenoml-*` properties are forwarded as HTTP
// headers by the raw client's destructure pattern.

import type * as phenoml from "../../../../index.js";

export interface FhirPatchRequest {
    "X-Phenoml-On-Behalf-Of"?: string;
    "X-Phenoml-Fhir-Provider"?: string;
    body: phenoml.fhir.FhirPatchRequestBodyItem[];
}
