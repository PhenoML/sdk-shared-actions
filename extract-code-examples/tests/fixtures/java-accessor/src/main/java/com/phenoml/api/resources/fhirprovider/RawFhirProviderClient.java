package com.phenoml.api.resources.fhirprovider;

import com.phenoml.api.core.ClientOptions;
import com.phenoml.api.core.PhenomlClientHttpResponse;

public class RawFhirProviderClient {
    protected final ClientOptions clientOptions;

    public RawFhirProviderClient(ClientOptions clientOptions) {
        this.clientOptions = clientOptions;
    }

    public PhenomlClientHttpResponse<FhirProviderResponse> create(FhirProviderCreateRequest request) {
        HttpUrl.Builder httpUrl = HttpUrl.parse(this.clientOptions.environment().getUrl())
                .newBuilder()
                .addPathSegments("fhir-provider");
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("POST", body)
                .build();
        return new PhenomlClientHttpResponse<>(null, null);
    }
}
