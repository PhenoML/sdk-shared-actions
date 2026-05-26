package com.phenoml.api.resources.agent;

// Minimal Fern Java Raw*Client.java shape exercising the slim parser:
// PhenoMLHttpResponse<...> return type, addPathSegment(s) + .method("...", ...).

public class RawAgentClient {
    public PhenoMLHttpResponse<AgentResponse> create(AgentCreateRequest request) {
        return create(request, null);
    }
    public PhenoMLHttpResponse<AgentResponse> create(AgentCreateRequest request, RequestOptions requestOptions) {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("agent/create")
                .build();
        RequestBody body = RequestBody.create(new byte[0], MediaTypes.APPLICATION_JSON);
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("POST", body)
                .build();
        return null;
    }

    public PhenoMLHttpResponse<AgentResponse> get(String id) {
        return get(id, null);
    }
    public PhenoMLHttpResponse<AgentResponse> get(String id, RequestOptions requestOptions) {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("agent")
                .addPathSegment(id)
                .build();
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("GET", null)
                .build();
        return null;
    }

    public PhenoMLHttpResponse<Void> delete(String id) {
        return delete(id, null);
    }
    public PhenoMLHttpResponse<Void> delete(String id, RequestOptions requestOptions) {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("agent")
                .addPathSegment(id)
                .build();
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("DELETE", null)
                .build();
        return null;
    }

    public PhenoMLHttpResponse<AgentListResponse> list() {
        return list(null);
    }
    public PhenoMLHttpResponse<AgentListResponse> list(RequestOptions requestOptions) {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("agent/list")
                .build();
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("GET", null)
                .build();
        return null;
    }

    // Streaming endpoint: HttpUrl.newBuilder for the URL, then a SECOND
    // .newBuilder() on the OkHttpClient for the timeout. Path collection
    // must stop at the first .build() so the second builder isn't confused
    // for path construction.
    public PhenoMLHttpResponse<Iterable<StreamEvent>> stream(StreamRequest request) {
        return stream(request, null);
    }
    public PhenoMLHttpResponse<Iterable<StreamEvent>> stream(StreamRequest request, RequestOptions requestOptions) {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("agent/stream")
                .build();
        OkHttpClient client = new OkHttpClient.Builder().build();
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("POST", null)
                .build();
        return null;
    }
}
