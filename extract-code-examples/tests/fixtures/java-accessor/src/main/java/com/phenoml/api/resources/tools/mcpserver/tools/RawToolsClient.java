package com.phenoml.api.resources.tools.mcpserver.tools;

import com.phenoml.api.core.ClientOptions;
import com.phenoml.api.core.PhenomlClientHttpResponse;

public class RawToolsClient {
    protected final ClientOptions clientOptions;

    public RawToolsClient(ClientOptions clientOptions) {
        this.clientOptions = clientOptions;
    }

    public PhenomlClientHttpResponse<ToolListResponse> list(String mcpServerId) {
        HttpUrl.Builder httpUrl = HttpUrl.parse(this.clientOptions.environment().getUrl())
                .newBuilder()
                .addPathSegments("tools/mcp-server")
                .addPathSegment(mcpServerId)
                .addPathSegments("list");
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("GET", null)
                .build();
        return new PhenomlClientHttpResponse<>(null, null);
    }
}
