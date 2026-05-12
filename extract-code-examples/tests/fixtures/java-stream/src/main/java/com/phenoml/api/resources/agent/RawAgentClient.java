// Synthetic fixture: streaming endpoints call `.newBuilder()` twice in the
// same method body — once on the `HttpUrl` to build the URL, and again later
// on the `OkHttpClient` to configure a custom call timeout. The second call
// must NOT clobber the captured path segments. The `streamChat` method below
// mirrors that pattern with an `Iterable<...>` response wrapped in
// `PhenomlClientHttpResponse`.
package com.phenoml.api.resources.agent;

import com.phenoml.api.core.PhenomlClientHttpResponse;
import java.util.concurrent.TimeUnit;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public class RawAgentClient {
    protected final ClientOptions clientOptions;

    public RawAgentClient(ClientOptions clientOptions) {
        this.clientOptions = clientOptions;
    }

    public PhenomlClientHttpResponse<Iterable<AgentChatStreamEvent>> streamChat(
            AgentStreamChatRequest request, RequestOptions requestOptions) {
        HttpUrl.Builder httpUrl = HttpUrl.parse(this.clientOptions.environment().getUrl())
                .newBuilder()
                .addPathSegments("agent/stream-chat");
        Request okhttpRequest = new Request.Builder()
                .url(httpUrl.build())
                .method("POST", null)
                .build();
        OkHttpClient client = clientOptions.httpClient();
        client = client.newBuilder().callTimeout(0, TimeUnit.SECONDS).build();
        try {
            Response response = client.newCall(okhttpRequest).execute();
            return new PhenomlClientHttpResponse<>(null, response);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
