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
        )
        return _response

    def stream(self, *, prompt, request_options=None):
        with self._client_wrapper.httpx_client.stream(
            "agent/stream",
            method="POST",
            json={"prompt": prompt},
        ) as _response:
            yield _response


class AsyncRawAgentClient:
    """Async twin — only sync class is parsed."""
    def create(self): pass
