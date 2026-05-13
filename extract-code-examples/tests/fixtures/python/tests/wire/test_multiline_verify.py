"""Synthetic fixture: wire tests whose verify_request_count calls are wrapped
across multiple lines by Black. Two forms appear in real Fern-generated SDKs:

  Form A — open paren alone, args on a single inner line, close paren alone:
      verify_request_count(
          test_id, "GET", "/path", {...}, 1
      )

  Form B — one argument per line:
      verify_request_count(
          test_id,
          "GET",
          "/path",
          {...},
          1,
      )

The single-line regex used to drop both forms silently. The parser must now
collect lines forward through balanced parens before matching.
"""

from .conftest import get_client, verify_request_count


def test_authtoken_auth_get_token_wrapped_inline() -> None:
    """Form A: args + path on the same line, open and close paren alone."""
    test_id = "authtoken.auth.get_token.wrappedA"
    client = get_client(test_id)
    client.authtoken.auth.get_token()
    verify_request_count(
        test_id, "POST", "/v2/auth/token", None, 1
    )


def test_authtoken_auth_get_token_wrapped_per_arg() -> None:
    """Form B: one arg per line — what Black emits for long arg lists."""
    test_id = "authtoken.auth.get_token.wrappedB"
    client = get_client(test_id)
    client.authtoken.auth.get_token()
    verify_request_count(
        test_id,
        "POST",
        "/v2/auth/token",
        None,
        1,
    )
