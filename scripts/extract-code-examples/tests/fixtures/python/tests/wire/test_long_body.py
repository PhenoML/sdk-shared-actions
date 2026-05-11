"""Synthetic fixture: a wire test whose body extends past 60 lines.

Used by extract-code-examples.test.ts to verify that the Python wire-test
scanner no longer caps at 60 lines. The SDK call and verify_request_count
are pushed to ~line 70 so a 60-line cap would silently drop this test.
"""

from .conftest import get_client, verify_request_count


def test_long_body_get_token() -> None:
    """Test with a deliberately long body."""
    test_id = "long_body.get_token.0"
    client = get_client(test_id)

    # Filler lines so the SDK call appears after line 60. Each comment counts
    # as one line and the scanner walks every line in the body.
    # 1
    # 2
    # 3
    # 4
    # 5
    # 6
    # 7
    # 8
    # 9
    # 10
    # 11
    # 12
    # 13
    # 14
    # 15
    # 16
    # 17
    # 18
    # 19
    # 20
    # 21
    # 22
    # 23
    # 24
    # 25
    # 26
    # 27
    # 28
    # 29
    # 30
    # 31
    # 32
    # 33
    # 34
    # 35
    # 36
    # 37
    # 38
    # 39
    # 40
    # 41
    # 42
    # 43
    # 44
    # 45
    # 46
    # 47
    # 48
    # 49
    # 50
    # 51
    # 52
    # 53
    # 54
    # 55
    # 56
    # 57
    # 58
    # 59
    # 60
    client.authtoken.auth.get_token()
    verify_request_count(test_id, "POST", "/v2/auth/token", None, 2)
