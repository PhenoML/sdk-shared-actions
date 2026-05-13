// Synthetic fixture: exercises multi-line method signatures with a non-API
// helper method between two API methods. If the multi-line-signature exit
// detection is broken, the helper's `.method(...)` / `.addPathSegments(...)`
// patterns will overwrite the first API method's collected state before it
// gets saved, mapping it to the helper's bogus values.
package com.phenoml.api.resources.thing;

import com.phenoml.api.core.PhenomlClientHttpResponse;
import okhttp3.HttpUrl;
import okhttp3.Request;

public class RawThingClient {
    protected final ClientOptions clientOptions;

    public RawThingClient(ClientOptions clientOptions) {
        this.clientOptions = clientOptions;
    }

    // Multi-line signature: `{` is on the next line.
    public PhenomlClientHttpResponse<Response> getThing(
            RequestOptions requestOptions) {
        HttpUrl.Builder httpUrl = HttpUrl.parse(this.clientOptions.environment().getUrl())
                .newBuilder()
                .addPathSegments("things");
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("GET", null)
                .build();
        return execute(okhttpRequest);
    }

    // Private helper between API methods. Returns Object (not
    // PhenomlClientHttpResponse) so it must NOT match the method regex —
    // but it contains the same builder pattern that would corrupt state.
    private Object helper() {
        HttpUrl.Builder bogus = HttpUrl.parse("x")
                .newBuilder()
                .addPathSegments("wrong/path");
        Request bogusReq = new Request.Builder()
                .url(bogus.build())
                .method("PUT", null)
                .build();
        return bogusReq;
    }

    // Another API method.
    public PhenomlClientHttpResponse<Response> postThing(Body body) {
        HttpUrl.Builder httpUrl = HttpUrl.parse(this.clientOptions.environment().getUrl())
                .newBuilder()
                .addPathSegments("things");
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("POST", body)
                .build();
        return execute(okhttpRequest);
    }

    // Multi-line signature with one parameter per line: the body's `{` only
    // appears on line 5. Each parameter line stays at the class-body brace
    // depth, so the method-exit check must distinguish "signature still open"
    // from "body closed."
    public PhenomlClientHttpResponse<Response> getThingById(
            String codesystem,
            String codeId,
            RequestBody request,
            RequestOptions requestOptions) {
        HttpUrl.Builder httpUrl = HttpUrl.parse(this.clientOptions.environment().getUrl())
                .newBuilder()
                .addPathSegments("things")
                .addPathSegment(codesystem)
                .addPathSegment(codeId);
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("GET", null)
                .build();
        return execute(okhttpRequest);
    }
}
