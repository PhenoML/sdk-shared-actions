package com.phenoml.api.resources.fhirprovider;

// Minimal raw client so the accessor-map test has a corresponding raw client
// to derive an actual method chain. The endpoint isn't covered by the shared
// fixture spec, so it'll show up as an orphan SDK mapping (which the manifest
// builder warns about but doesn't error on).
public class RawFhirProviderClient {
    public PhenoMLHttpResponse<Object> ping() {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("fhir-provider/ping")
                .build();
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("GET", null)
                .build();
        return null;
    }
}
