/**
 * Synthetic request-class fixture for the passthrough-body case. Mirrors
 * Fern's generated FhirPatchRequest: two @JsonIgnore'd header fields plus
 * a `body` field whose value IS the wire body (a JSON Patch array). The
 * raw client unwraps `request.getBody()` and serializes only that value.
 */
package com.phenoml.api.resources.fhir.requests;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.phenoml.api.resources.fhir.types.FhirPatchRequestBodyItem;
import java.util.List;
import java.util.Optional;

@JsonInclude(JsonInclude.Include.NON_ABSENT)
public final class FhirPatchRequest {
    private final Optional<String> phenomlOnBehalfOf;

    private final Optional<String> phenomlFhirProvider;

    private final List<FhirPatchRequestBodyItem> body;

    private FhirPatchRequest(
            Optional<String> phenomlOnBehalfOf,
            Optional<String> phenomlFhirProvider,
            List<FhirPatchRequestBodyItem> body) {
        this.phenomlOnBehalfOf = phenomlOnBehalfOf;
        this.phenomlFhirProvider = phenomlFhirProvider;
        this.body = body;
    }

    @JsonIgnore
    public Optional<String> getPhenomlOnBehalfOf() {
        return phenomlOnBehalfOf;
    }

    @JsonIgnore
    public Optional<String> getPhenomlFhirProvider() {
        return phenomlFhirProvider;
    }

    @JsonProperty("body")
    public List<FhirPatchRequestBodyItem> getBody() {
        return body;
    }

    public static BodyStage builder() {
        return new Builder();
    }

    public interface BodyStage {
        _FinalStage body(List<FhirPatchRequestBodyItem> body);
    }

    public interface _FinalStage {
        FhirPatchRequest build();
        _FinalStage phenomlOnBehalfOf(Optional<String> phenomlOnBehalfOf);
        _FinalStage phenomlOnBehalfOf(String phenomlOnBehalfOf);
        _FinalStage phenomlFhirProvider(Optional<String> phenomlFhirProvider);
        _FinalStage phenomlFhirProvider(String phenomlFhirProvider);
    }

    public static final class Builder implements BodyStage, _FinalStage {
        private List<FhirPatchRequestBodyItem> body;
        private Optional<String> phenomlOnBehalfOf = Optional.empty();
        private Optional<String> phenomlFhirProvider = Optional.empty();

        private Builder() {}

        public _FinalStage body(List<FhirPatchRequestBodyItem> body) { this.body = body; return this; }
        public _FinalStage phenomlOnBehalfOf(String value) { this.phenomlOnBehalfOf = Optional.ofNullable(value); return this; }
        public _FinalStage phenomlOnBehalfOf(Optional<String> value) { this.phenomlOnBehalfOf = value; return this; }
        public _FinalStage phenomlFhirProvider(String value) { this.phenomlFhirProvider = Optional.ofNullable(value); return this; }
        public _FinalStage phenomlFhirProvider(Optional<String> value) { this.phenomlFhirProvider = value; return this; }

        public FhirPatchRequest build() {
            return new FhirPatchRequest(phenomlOnBehalfOf, phenomlFhirProvider, body);
        }
    }
}
