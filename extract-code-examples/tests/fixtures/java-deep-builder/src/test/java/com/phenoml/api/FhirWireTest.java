package com.phenoml.api;

import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.junit.jupiter.api.Test;

public class FhirWireTest {
    private MockWebServer server;
    private PhenomlClient client;

    @Test
    public void testExecuteBundle() throws Exception {
        server.enqueue(new MockResponse()
                .setResponseCode(200)
                .setBody("{\"access_token\":\"test-token\",\"expires_in\":3600}"));
        server.enqueue(new MockResponse()
                .setResponseCode(200)
                .setBody("{\"resourceType\":\"Bundle\",\"total\":1}"));
        FhirBundle response = client.fhir()
                .executeBundle(
                        "550e8400-e29b-41d4-a716-446655440000",
                        FhirExecuteBundleRequest.builder()
                                .body(FhirBundle.builder()
                                        .entry(Arrays.asList(
                                                FhirBundleEntryItem.builder()
                                                        .resource(new HashMap<String, Object>() {
                                                            {
                                                                put("resourceType", "Patient");
                                                                put(
                                                                        "name",
                                                                        new ArrayList<Object>(Arrays.asList(
                                                                                new HashMap<String, Object>() {
                                                                                    {
                                                                                        put("family", "Doe");
                                                                                        put(
                                                                                                "given",
                                                                                                new ArrayList<Object>(
                                                                                                        Arrays.asList(
                                                                                                                "John")));
                                                                                    }
                                                                                })));
                                                            }
                                                        })
                                                        .request(FhirBundleEntryItemRequest.builder()
                                                                .method(FhirBundleEntryItemRequestMethod.POST)
                                                                .url("Patient")
                                                                .build())
                                                        .build(),
                                                FhirBundleEntryItem.builder()
                                                        .resource(new HashMap<String, Object>() {
                                                            {
                                                                put("resourceType", "Observation");
                                                                put("status", "final");
                                                            }
                                                        })
                                                        .request(FhirBundleEntryItemRequest.builder()
                                                                .method(FhirBundleEntryItemRequestMethod.POST)
                                                                .url("Observation")
                                                                .build())
                                                        .build()))
                                        .build())
                                .phenomlOnBehalfOf("Patient/550e8400-e29b-41d4-a716-446655440000")
                                .build());
        RecordedRequest request = server.takeRequest();
        Assertions.assertEquals("POST", request.getMethod());
    }
}
