// Synthetic fixture: discriminated-union *Request that lives under
// types/ rather than client/requests/. The schema builder must (a) find
// it via the types/ fallback path and (b) fall back to a synthetic
// passthrough body field with `kind: "object"` so the consumer renders
// the example body verbatim instead of dropping it.

import type * as phenoml from "../../../index.js";

export type AgentAddAuthConfigRequest =
    | phenoml.agent.AgentAddAuthConfigRequest.Jwt
    | phenoml.agent.AgentAddAuthConfigRequest.ClientSecret;

export namespace AgentAddAuthConfigRequest {
    export interface Jwt {
        auth_method: "jwt";
        jwt_token: string;
    }

    export interface ClientSecret {
        auth_method: "client_secret";
        client_id: string;
        client_secret: string;
    }
}
