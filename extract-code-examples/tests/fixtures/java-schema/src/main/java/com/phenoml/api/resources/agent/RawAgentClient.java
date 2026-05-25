/**
 * Synthetic fixture for schema extraction. Mirrors Fern's generated shape:
 *   - Whole-object body via writeValueAsBytes(request)
 *   - Header forwarding via _requestBuilder.addHeader("X-...", request.getX()...)
 *   - Two positional path params
 */
package com.phenoml.api.resources.agent;

import com.phenoml.api.core.MediaTypes;
import com.phenoml.api.core.ObjectMappers;
import com.phenoml.api.core.PhenomlClientHttpResponse;
import com.phenoml.api.core.RequestOptions;
import com.phenoml.api.resources.agent.requests.CreateAgentRequest;
import com.phenoml.api.resources.agent.types.JsonPatchOperation;
import com.phenoml.api.resources.fhirProvider.types.FhirProviderAddAuthConfigRequest;
import java.util.List;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class RawAgentClient {
    public PhenomlClientHttpResponse<Object> createAgent(
            String orgId, String teamId, CreateAgentRequest request, RequestOptions requestOptions) {
        HttpUrl.Builder httpUrl = HttpUrl.parse("https://x").newBuilder()
                .addPathSegments("org")
                .addPathSegment(orgId)
                .addPathSegments("teams")
                .addPathSegment(teamId)
                .addPathSegments("agents");
        RequestBody body;
        try {
            body = RequestBody.create(
                    ObjectMappers.JSON_MAPPER.writeValueAsBytes(request), MediaTypes.APPLICATION_JSON);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        Request.Builder _requestBuilder = new Request.Builder()
                .url(httpUrl.build())
                .method("POST", body)
                .addHeader("Content-Type", "application/json");
        if (request.getPhenomlOnBehalfOf().isPresent()) {
            _requestBuilder.addHeader(
                    "X-Phenoml-On-Behalf-Of", request.getPhenomlOnBehalfOf().get());
        }
        Request okhttpRequest = _requestBuilder.build();
        OkHttpClient client = new OkHttpClient();
        try {
            return new PhenomlClientHttpResponse<>(new Object(), client.newCall(okhttpRequest).execute());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // List-typed body. Fern emits `List<JsonPatchOperation>` directly as
    // the trailing param (no wrapping request class) for JSON Patch
    // endpoints. The body is the whole param, serialized via
    // writeValueAsBytes(request). The render schema must skip the
    // `.builder().build()` envelope and synthesize a list passthrough
    // body — see javaResolveListItemField.
    public PhenomlClientHttpResponse<Object> patch(
            String id, List<JsonPatchOperation> request, RequestOptions requestOptions) {
        HttpUrl.Builder httpUrl = HttpUrl.parse("https://x").newBuilder()
                .addPathSegments("agent")
                .addPathSegment(id);
        RequestBody body;
        try {
            body = RequestBody.create(
                    ObjectMappers.JSON_MAPPER.writeValueAsBytes(request), MediaTypes.APPLICATION_JSON);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("PATCH", body)
                .build();
        OkHttpClient client = new OkHttpClient();
        try {
            return new PhenomlClientHttpResponse<>(new Object(), client.newCall(okhttpRequest).execute());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // Discriminated-union body. Fern emits a `*Request`-named Jackson
    // union (with `@JsonSubTypes` on an inner Value interface) for
    // OpenAPI oneOf bodies. The class has no `.builder()` — only static
    // factory methods like `jwt(...)` / `clientSecret(...)`. The render
    // schema must skip the builder envelope and emit a passthrough
    // object body so the consumer renders the example wire body
    // verbatim instead of producing broken
    // `FhirProviderAddAuthConfigRequest.builder().value(...).build()`.
    public PhenomlClientHttpResponse<Object> addAuthConfig(
            String fhirProviderId, FhirProviderAddAuthConfigRequest request, RequestOptions requestOptions) {
        HttpUrl.Builder httpUrl = HttpUrl.parse("https://x").newBuilder()
                .addPathSegments("fhir-provider")
                .addPathSegment(fhirProviderId)
                .addPathSegments("add-auth-config");
        RequestBody body;
        try {
            body = RequestBody.create(
                    ObjectMappers.JSON_MAPPER.writeValueAsBytes(request), MediaTypes.APPLICATION_JSON);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("PATCH", body)
                .build();
        OkHttpClient client = new OkHttpClient();
        try {
            return new PhenomlClientHttpResponse<>(new Object(), client.newCall(okhttpRequest).execute());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
