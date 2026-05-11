# Minimal conftest for fixture. Real implementation lives in the SDK repo.
def get_client(test_id):
    raise NotImplementedError


def verify_request_count(test_id, method, path, query_params, count):
    raise NotImplementedError
