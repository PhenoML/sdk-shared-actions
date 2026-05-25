/**
 * Synthetic fixture: minimal JSON Patch operation type. The schema
 * extractor only needs the class to exist + parse — none of its fields
 * are read during the passthrough-body tests.
 */
package com.phenoml.api.resources.fhir.types;

public final class FhirPatchRequestBodyItem {
    private final String op;
    private final String path;
}
