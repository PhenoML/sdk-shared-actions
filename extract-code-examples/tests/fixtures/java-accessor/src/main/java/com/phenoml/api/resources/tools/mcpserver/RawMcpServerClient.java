package com.phenoml.api.resources.tools.mcpserver;

import com.phenoml.api.core.ClientOptions;
import com.phenoml.api.core.PhenomlClientHttpResponse;

public class RawMcpServerClient {
    protected final ClientOptions clientOptions;

    public RawMcpServerClient(ClientOptions clientOptions) {
        this.clientOptions = clientOptions;
    }

    public PhenomlClientHttpResponse<McpServerResponse> create(McpServerCreateRequest request) {
        HttpUrl.Builder httpUrl = HttpUrl.parse(this.clientOptions.environment().getUrl())
                .newBuilder()
                .addPathSegments("tools/mcp-server");
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("POST", body)
                .build();
        return new PhenomlClientHttpResponse<>(null, null);
    }
}
