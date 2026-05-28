"""Minimal fixture mimicking Fern Python raw_client.py shape."""

class RawAgentClient:
    def __init__(self, client_wrapper):
        self._client_wrapper = client_wrapper

    def create(self, *, name, description=None, role, request_options=None):
        _response = self._client_wrapper.httpx_client.request(
            "agent/create",
            method="POST",
            json={"name": name, "description": description, "role": role},
        )
        return _response

    def get(self, id, *, request_options=None):
        _response = self._client_wrapper.httpx_client.request(
            f"agent/{jsonable_encoder(id)}",
            method="GET",
        )
        return _response

    def delete(self, id, *, request_options=None):
        _response = self._client_wrapper.httpx_client.request(
            f"agent/{jsonable_encoder(id)}",
            method="DELETE",
        )
        return _response

    def list(self, *, tags=None, request_options=None):
        _response = self._client_wrapper.httpx_client.request(
            "agent/list",
            method="GET",
            params={"tags": tags},
        )
        return _response

    def stream(self, *, prompt, request_options=None):
        with self._client_wrapper.httpx_client.stream(
            "agent/stream",
            method="POST",
            json={"prompt": prompt},
        ) as _response:
            yield _response

    def patch_with_filter(self, id, *, request, verbose=None, request_options=None):
        # Passthrough body: a JSON Patch array passed straight through as
        # `request`. Exercises bodyKwargForPassthrough extraction.
        _response = self._client_wrapper.httpx_client.request(
            f"agent/{jsonable_encoder(id)}/patch-with-filter",
            method="PATCH",
            json=jsonable_encoder(request),
        )
        return _response

    def post_code(self, code_id, *, resource_type, fhir_path=None, request_options=None):
        # camelCase OpenAPI keys mapped to snake_case Python identifiers —
        # exercises bodyKwargByJsonKey extraction. The path param `code_id`
        # is the SDK identifier for the spec's `codeID`.
        _response = self._client_wrapper.httpx_client.request(
            f"construe/codes/{jsonable_encoder(code_id)}",
            method="POST",
            json={"resourceType": resource_type, "fhir_path": fhir_path},
        )
        return _response


class AsyncRawAgentClient:
    """Async twin — only sync class is parsed."""
    def create(self): pass
