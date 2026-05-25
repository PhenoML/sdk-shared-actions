/**
 * Synthetic fixture: mirrors the real Fern-generated FHIR raw client's
 * patch method. The body is built via
 * `writeValueAsBytes(request.getBody())` — only the body field's value
 * ships on the wire, not the whole `request`. Exercises the passthrough
 * body detection.
 */
package com.phenoml.api.resources.fhir;

import com.phenoml.api.core.MediaType;
import com.phenoml.api.core.ObjectMappers;
import com.phenoml.api.core.PhenomlClientHttpResponse;
import com.phenoml.api.core.RequestOptions;
import com.phenoml.api.resources.fhir.requests.FhirPatchRequest;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class RawFhirClient {
    public PhenomlClientHttpResponse<Object> patch(
            String fhirProviderId, String fhirPath, FhirPatchRequest request, RequestOptions requestOptions) {
        HttpUrl.Builder httpUrl = HttpUrl.parse("https://x").newBuilder()
                .addPathSegments("fhir-provider")
                .addPathSegment(fhirProviderId)
                .addPathSegments("fhir")
                .addPathSegment(fhirPath);
        RequestBody body;
        try {
            body = RequestBody.create(
                    ObjectMappers.JSON_MAPPER.writeValueAsBytes(request.getBody()),
                    MediaType.parse("application/json-patch+json"));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        Request.Builder _requestBuilder = new Request.Builder()
                .url(httpUrl.build())
                .method("PATCH", body)
                .addHeader("Content-Type", "application/json-patch+json");
        if (request.getPhenomlOnBehalfOf().isPresent()) {
            _requestBuilder.addHeader(
                    "X-Phenoml-On-Behalf-Of", request.getPhenomlOnBehalfOf().get());
        }
        if (request.getPhenomlFhirProvider().isPresent()) {
            _requestBuilder.addHeader(
                    "X-Phenoml-Fhir-Provider", request.getPhenomlFhirProvider().get());
        }
        Request okhttpRequest = _requestBuilder.build();
        OkHttpClient client = new OkHttpClient();
        try {
            return new PhenomlClientHttpResponse<>(new Object(), client.newCall(okhttpRequest).execute());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
