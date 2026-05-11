package com.phenoml.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.phenoml.api.core.TestResources;
import com.phenoml.api.resources.fhirprovider.types.FhirProviderResponse;
import com.phenoml.api.resources.fhirprovider.requests.FhirProviderCreateRequest;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

public class FhirProviderWireTest {
    private MockWebServer server;
    private PhenomlClient client;
    private ObjectMapper objectMapper = new ObjectMapper();

    @Test
    public void testCreate() throws Exception {
        // OAuth: enqueue token response (client fetches token before API call)
        server.enqueue(new MockResponse()
                .setResponseCode(200)
                .setBody("{\"access_token\":\"test-token\",\"expires_in\":3600}"));
        server.enqueue(new MockResponse()
                .setResponseCode(200)
                .setBody(TestResources.loadResource("/wire-tests/FhirProviderWireTest_testCreate_response.json")));
        FhirProviderResponse response = client.fhirProvider()
                .create(FhirProviderCreateRequest.builder()
                        .name("Epic Sandbox")
                        .provider(Provider.ATHENAHEALTH)
                        .build());
        // OAuth: consume the token request
        server.takeRequest();
        RecordedRequest request = server.takeRequest();
        Assertions.assertNotNull(request);
        Assertions.assertEquals("POST", request.getMethod());

        String expectedRequestBody = "{\"name\":\"Epic Sandbox\",\"provider\":\"athenahealth\"}";
        JsonNode expectedRequestNode = objectMapper.readTree(expectedRequestBody);
        JsonNode actualRequestNode = objectMapper.readTree(request.getBody().readUtf8());
        Assertions.assertEquals(expectedRequestNode, actualRequestNode);

        String expectedResponseBody =
                TestResources.loadResource("/wire-tests/FhirProviderWireTest_testCreate_response.json");
        JsonNode expectedResponseNode = objectMapper.readTree(expectedResponseBody);
        JsonNode actualResponseNode = objectMapper.readTree(objectMapper.writeValueAsString(response));
        Assertions.assertEquals(expectedResponseNode, actualResponseNode);
    }
}
