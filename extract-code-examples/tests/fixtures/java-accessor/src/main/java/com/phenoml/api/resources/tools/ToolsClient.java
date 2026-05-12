package com.phenoml.api.resources.tools;

import com.phenoml.api.resources.tools.mcpserver.McpServerClient;

public class ToolsClient {
    protected final Suppliers.Memoize<McpServerClient> mcpServerClient;

    public ToolsClient() {}

    public McpServerClient mcpServer() {
        return this.mcpServerClient.get();
    }
}
