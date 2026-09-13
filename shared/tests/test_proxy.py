import asyncio

from shared.proxy import create_prefix_strip_middleware


class FakeRequest:
    def __init__(self, path, scheme="http", headers=None):
        self.scope = {"path": path, "scheme": scheme, "root_path": ""}
        self.headers = headers or {}


async def _next(request):
    return "next"


def _run(dispatch, request):
    return asyncio.run(dispatch(request, _next))


def test_no_prefix_is_noop(monkeypatch):
    monkeypatch.delenv("PATH_PREFIX", raising=False)
    request = FakeRequest("/widgets")
    assert _run(create_prefix_strip_middleware(), request) == "next"
    assert request.scope["path"] == "/widgets"
    assert request.scope["root_path"] == ""


def test_strips_prefix_and_sets_root_path_and_scheme(monkeypatch):
    monkeypatch.setenv("PATH_PREFIX", "/server")
    request = FakeRequest("/server/widgets", headers={"x-forwarded-proto": "https"})
    _run(create_prefix_strip_middleware(), request)
    assert request.scope["path"] == "/widgets"
    assert request.scope["root_path"] == "/server"
    assert request.scope["scheme"] == "https"


def test_exact_prefix_becomes_root(monkeypatch):
    monkeypatch.setenv("PATH_PREFIX", "/server")
    request = FakeRequest("/server")
    _run(create_prefix_strip_middleware(), request)
    assert request.scope["path"] == "/"


def test_root_path_set_even_when_proxy_already_stripped(monkeypatch):
    monkeypatch.setenv("PATH_PREFIX", "/server")
    request = FakeRequest("/widgets", headers={"x-forwarded-proto": "https"})
    _run(create_prefix_strip_middleware(), request)
    assert request.scope["path"] == "/widgets"
    assert request.scope["root_path"] == "/server"
    assert request.scope["scheme"] == "https"
