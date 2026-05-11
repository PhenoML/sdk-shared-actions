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
