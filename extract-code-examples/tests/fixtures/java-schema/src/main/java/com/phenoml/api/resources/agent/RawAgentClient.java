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
}
