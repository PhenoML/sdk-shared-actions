// Synthetic fixture exercising the positional-path-param + request-object
// signature shape Fern emits for endpoints with URL placeholders, e.g.
// `getAgent(agentId, { version: "..." })`.

export interface GetAgentRequest {
    version?: string;
}
