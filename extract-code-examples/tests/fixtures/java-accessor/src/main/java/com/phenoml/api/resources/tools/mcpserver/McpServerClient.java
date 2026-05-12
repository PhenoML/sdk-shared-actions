package com.phenoml.api.resources.tools.mcpserver;

import com.phenoml.api.resources.tools.mcpserver.tools.ToolsClient;

public class McpServerClient {
    protected final RawMcpServerClient rawClient;
    protected final Suppliers.Memoize<ToolsClient> toolsClient;

    public McpServerClient(RawMcpServerClient rawClient) {
        this.rawClient = rawClient;
    }

    public ToolsClient tools() {
        return this.toolsClient.get();
    }
}
