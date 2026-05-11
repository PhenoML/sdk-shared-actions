package com.phenoml.api;

import com.phenoml.api.resources.fhirprovider.FhirProviderClient;
import com.phenoml.api.resources.tools.ToolsClient;

public class PhenomlClient {
    protected final Suppliers.Memoize<FhirProviderClient> fhirProviderClient;
    protected final Suppliers.Memoize<ToolsClient> toolsClient;

    public PhenomlClient() {}

    public FhirProviderClient fhirProvider() {
        return this.fhirProviderClient.get();
    }

    public ToolsClient tools() {
        return this.toolsClient.get();
    }
}
