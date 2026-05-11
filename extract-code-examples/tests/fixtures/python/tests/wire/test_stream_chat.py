"""Synthetic fixture: a streaming wire test wrapped in `for _ in ...:`.

This mirrors the shape Fern's Python generator emits for streaming endpoints.
Used to verify the Python parser strips the `for` header's trailing `:` from
the captured sdkCallSource (instead of emitting invalid Python).
"""

from .conftest import get_client, verify_request_count


def test_agent_stream_chat() -> None:
    test_id = "agent.stream_chat.0"
    client = get_client(test_id)
    for _ in client.agent.stream_chat(
        phenoml_on_behalf_of="user@example.com",
        message="hello",
        agent_id="agent-123",
    ):
        pass
    verify_request_count(test_id, "POST", "/agent/stream-chat", None, 1)
