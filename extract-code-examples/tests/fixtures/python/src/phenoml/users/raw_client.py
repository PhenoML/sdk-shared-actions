# Synthetic Python fixture: exercises a path parameter in camelCase.
# Fern's Python generator typically emits snake_case path params, but
# pyExtractEndpoints applies normalizePathParams() defensively so the
# manifest key stays consistent with the TS/Java parsers if that changes.

import typing
from ..core.client_wrapper import SyncClientWrapper
from ..core.http_response import HttpResponse
from ..core.request_options import RequestOptions


class RawUsersClient:
    def __init__(self, *, client_wrapper: SyncClientWrapper):
        self._client_wrapper = client_wrapper

    def get_user(
        self,
        user_id: str,
        *,
        request_options: typing.Optional[RequestOptions] = None,
    ) -> HttpResponse[typing.Any]:
        _response = self._client_wrapper.httpx_client.request(
            f"users/{jsonable_encoder(userId)}",
            method="GET",
            request_options=request_options,
        )
        return _response

    # Synthetic PATCH endpoint exercising the passthrough body pattern:
    # the raw client passes a single kwarg (`request`) directly as the JSON
    # payload, so the wire body IS the JSON Patch array — not a dict with
    # a "request" key. The renderSchema for this endpoint must mark the
    # `request` field with `passthroughBody: true` so consumers source the
    # value from `body` itself rather than `body["request"]`.
    def patch_user(
        self,
        user_id: str,
        *,
        request: typing.Sequence[PatchOperation],
        request_options: typing.Optional[RequestOptions] = None,
    ) -> HttpResponse[typing.Any]:
        _response = self._client_wrapper.httpx_client.request(
            f"users/{jsonable_encoder(user_id)}",
            method="PATCH",
            json=convert_and_respect_annotation_metadata(
                object_=request, annotation=typing.Sequence[PatchOperation], direction="write"
            ),
            headers={
                "content-type": "application/json-patch+json",
            },
            request_options=request_options,
        )
        return _response
