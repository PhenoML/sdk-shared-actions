package com.phenoml.api;

import com.phenoml.api.resources.agent.AgentClient;
import com.phenoml.api.resources.fhirprovider.FhirProviderClient;

// Top-level client wiring — the accessor-map builder reads this file to learn
// that the lowercased `fhirprovider` directory is reached via `fhirProvider()`
// in the SDK call chain. `agent` matches its directory name as-is.
public class PhenomlClient {
    public AgentClient agent() { return null; }
    public FhirProviderClient fhirProvider() { return null; }
}
