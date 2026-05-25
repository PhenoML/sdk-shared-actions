/**
 * Synthetic fixture: mirrors Fern's emitted Jackson discriminated union
 * for an OpenAPI `oneOf` request body. The outer class has no
 * `builder()` static method — only static factory methods per variant
 * (`jwt(...)`, `clientSecret(...)`) — and the inner Value interface
 * carries `@JsonSubTypes`. The Java schema builder must detect this
 * shape (via @JsonSubTypes) and emit a passthrough object body instead
 * of falling through to the builder envelope, which would produce
 * broken `FhirProviderAddAuthConfigRequest.builder().value(...).build()`.
 */
package com.phenoml.api.resources.fhirProvider.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

public final class FhirProviderAddAuthConfigRequest {
    private final Value value;

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    private FhirProviderAddAuthConfigRequest(Value value) {
        this.value = value;
    }

    public static FhirProviderAddAuthConfigRequest jwt(Object value) {
        return new FhirProviderAddAuthConfigRequest(null);
    }

    public static FhirProviderAddAuthConfigRequest clientSecret(Object value) {
        return new FhirProviderAddAuthConfigRequest(null);
    }

    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "auth_method")
    @JsonSubTypes({
        @JsonSubTypes.Type(JwtValue.class),
        @JsonSubTypes.Type(ClientSecretValue.class),
    })
    private interface Value {}

    private static final class JwtValue implements Value {}

    private static final class ClientSecretValue implements Value {}
}
