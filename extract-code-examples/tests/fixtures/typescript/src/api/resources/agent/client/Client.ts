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
