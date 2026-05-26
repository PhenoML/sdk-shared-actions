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

    // Real Fern Java wraps every query-param endpoint in a request class
    // (`AgentListRequest` here), regardless of how many query params the spec
    // declares. The full impl signature is `(AgentListRequest, RequestOptions)`;
    // the no-arg overload delegates to it. The parser's last-non-RequestOptions
    // heuristic picks up AgentListRequest, so callTemplate gets the builder wrap.
    public PhenoMLHttpResponse<AgentListResponse> list() {
        return list(AgentListRequest.builder().build());
    }
    public PhenoMLHttpResponse<AgentListResponse> list(RequestOptions requestOptions) {
        return list(AgentListRequest.builder().build(), requestOptions);
    }
    public PhenoMLHttpResponse<AgentListResponse> list(AgentListRequest request) {
        return list(request, null);
    }
    public PhenoMLHttpResponse<AgentListResponse> list(AgentListRequest request, RequestOptions requestOptions) {
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

    // `List<JsonPatchOperation>` body — the request class extractor must
    // return undefined (passthrough body), NOT "ListJsonPatchOperation".
    public PhenoMLHttpResponse<AgentResponse> patch(String id, List<JsonPatchOperation> request) {
        return patch(id, request, null);
    }
    public PhenoMLHttpResponse<AgentResponse> patch(String id, List<JsonPatchOperation> request, RequestOptions requestOptions) {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("agent")
                .addPathSegment(id)
                .build();
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("PATCH", null)
                .build();
        return null;
    }

    // Mixed path+body where the path param uses a wrapper type — the
    // extractor must pick the *last* non-RequestOptions param, not the first
    // non-primitive one (which would mis-select `UUID`).
    public PhenoMLHttpResponse<AgentResponse> updateByUuid(UUID id, AgentUpdateRequest request, RequestOptions requestOptions) {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("agent/by-uuid")
                .addPathSegment(id)
                .build();
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("PUT", null)
                .build();
        return null;
    }

    // `Optional<XxxRequest>` body — extractor must unwrap to `XxxRequest`.
    public PhenoMLHttpResponse<AgentResponse> fetchAgent(Optional<FetchRequest> request, RequestOptions requestOptions) {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("agent/fetch")
                .build();
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("POST", null)
                .build();
        return null;
    }

    // Multi-line method signature (one param per line). Fern emits this shape
    // for methods with three or more parameters; the previous parser broke on
    // signatures spanning 3+ lines (see commit history, pre-spec rewrite).
    public PhenoMLHttpResponse<AgentResponse> multiLine(
            String id,
            String tagId,
            AgentUpdateRequest request,
            RequestOptions requestOptions) {
        HttpUrl httpUrl = HttpUrl.parse("https://example").newBuilder()
                .addPathSegments("agent")
                .addPathSegment(id)
                .addPathSegments("tag")
                .addPathSegment(tagId)
                .build();
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl)
                .method("PATCH", null)
                .build();
        return null;
    }
}
