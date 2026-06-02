// Minimal Fern TypeScript Client.ts shape — only the patterns the slim
// parser cares about: `private async __X(...)` impls with a fetcher object
// literal carrying `url: core.url.join(...)` and `method: "..."`.

import * as core from "core";

export class AgentClient {
    public create(request: AgentCreateRequest, options?: AgentClient.RequestOptions): Promise<unknown> {
        return this.__create(request, options);
    }
    private async __create(request: AgentCreateRequest, options?: AgentClient.RequestOptions): Promise<unknown> {
        const _response = await core.fetcher({
            url: core.url.join(this._options.baseUrl, "agent/create"),
            method: "POST",
            body: request,
        });
        return _response;
    }

    public get(id: string): Promise<unknown> {
        return this.__get(id);
    }
    private async __get(id: string): Promise<unknown> {
        const _response = await core.fetcher({
            url: core.url.join(this._options.baseUrl, `agent/${core.url.encodePathParam(id)}`),
            method: "GET",
        });
        return _response;
    }

    public delete(id: string): Promise<unknown> {
        return this.__delete(id);
    }
    private async __delete(id: string): Promise<unknown> {
        const _response = await core.fetcher({
            url: core.url.join(this._options.baseUrl, `agent/${core.url.encodePathParam(id)}`),
            method: "DELETE",
        });
        return _response;
    }

    public list(): Promise<unknown> { return this.__list(); }
    private async __list(): Promise<unknown> {
        const _response = await core.fetcher({
            url: core.url.join(this._options.baseUrl, "agent/list"),
            method: "GET",
        });
        return _response;
    }

    public stream(request: { prompt: string }): Promise<unknown> { return this.__stream(request); }
    private async __stream(request: { prompt: string }): Promise<unknown> {
        const _response = await core.fetcher({
            url: core.url.join(this._options.baseUrl, "agent/stream"),
            method: "POST",
            body: request,
        });
        return _response;
    }

    // Fern request wrapper: a header member forces the body under a dedicated
    // `body` key (`body: _body` property binding). The decoy error literal
    // below also has a `body:` — the parser must read the fetcher literal's,
    // not the error one's.
    public wrapped(request: { body: unknown }): Promise<unknown> { return this.__wrapped(request); }
    private async __wrapped(request: { body: unknown }): Promise<unknown> {
        const { "X-Trace-Id": _traceId, body: _body } = request;
        const _response = await core.fetcher({
            url: core.url.join(this._options.baseUrl, "agent/wrapped"),
            method: "POST",
            body: _body,
        });
        if (!_response.ok) {
            throw new Error(JSON.stringify({ statusCode: 500, body: _response.error }));
        }
        return _response;
    }

    // Fern inlines the body when the wrapper spreads it in (`..._body` rest
    // binding) alongside header members — no `body` key, body fields stay flat.
    public inlinedRest(request: { name: string }): Promise<unknown> { return this.__inlinedRest(request); }
    private async __inlinedRest(request: { name: string }): Promise<unknown> {
        const { "X-Trace-Id": _traceId, ..._body } = request;
        const _response = await core.fetcher({
            url: core.url.join(this._options.baseUrl, "agent/inlined-rest"),
            method: "POST",
            body: _body,
        });
        return _response;
    }

    // Legacy Fern shape: direct string-literal URL with embedded host.
    public legacyString(): Promise<unknown> { return this.__legacyString(); }
    private async __legacyString(): Promise<unknown> {
        const _response = await core.fetcher({
            url: "https://example/agent/legacy",
            method: "POST",
        });
        return _response;
    }

    // Legacy Fern shape: direct template-literal URL with absolute host and
    // a bare-identifier path-param substitution.
    public legacyTemplate(id: string): Promise<unknown> { return this.__legacyTemplate(id); }
    private async __legacyTemplate(id: string): Promise<unknown> {
        const _response = await core.fetcher({
            url: `https://example/agent/${id}/legacy`,
            method: "GET",
        });
        return _response;
    }

    // Older Fern shape: `${baseUrl}` substitution as the URL prefix.
    public baseUrlSubst(id: string): Promise<unknown> { return this.__baseUrlSubst(id); }
    private async __baseUrlSubst(id: string): Promise<unknown> {
        const _response = await core.fetcher({
            url: `${this._options.baseUrl}/agent/${id}/subst`,
            method: "GET",
        });
        return _response;
    }

    private _options: { baseUrl: string } = { baseUrl: "https://example" };
}

export namespace AgentClient {
    export interface RequestOptions {}
}

interface AgentCreateRequest {
    name: string;
    description?: string;
    role: "assistant" | "user" | "system";
}
