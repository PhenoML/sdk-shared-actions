package com.phenoml.api.resources.fhirprovider;

public class FhirProviderClient {
    protected final RawFhirProviderClient rawClient;

    public FhirProviderClient(RawFhirProviderClient rawClient) {
        this.rawClient = rawClient;
    }

    // Endpoint accessors live on RawFhirProviderClient. PhenomlClient exposes
    // this class via the `fhirProvider()` accessor, not `fhirprovider()`.
}
