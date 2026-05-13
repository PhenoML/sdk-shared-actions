package com.phenoml.api.resources.fhir;

import com.phenoml.api.core.PhenomlClientHttpResponse;

public class RawFhirClient {
    public PhenomlClientHttpResponse<FhirBundle> executeBundle(String fhirProviderId, FhirExecuteBundleRequest request) {
        HttpUrl.Builder httpUrl = HttpUrl.parse(url)
                .newBuilder()
                .addPathSegments("fhir-provider")
                .addPathSegment(fhirProviderId)
                .addPathSegments("fhir");
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("POST", body)
                .build();
        return null;
    }
}
