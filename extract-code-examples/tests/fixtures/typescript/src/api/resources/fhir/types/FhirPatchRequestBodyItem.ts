// Synthetic fixture: minimal JSON Patch operation type. Real Fern output
// is richer; the schema-extraction tests don't require the variant set,
// only that the interface exists so nested-type resolution finds it.

export interface FhirPatchRequestBodyItem {
    op: string;
    path: string;
    value?: unknown;
}
