import socket

import pytest

from shared.ssrf import assert_source_url_allowed


def _fake_getaddrinfo(ips):
    def fake(host, port, proto=0):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443))
            for ip in ips
        ]

    return fake


def test_allows_https_with_public_ip(monkeypatch):
    monkeypatch.setattr("shared.ssrf.socket.getaddrinfo", _fake_getaddrinfo(["8.8.8.8"]))
    assert_source_url_allowed("https://example.com/x")


def test_rejects_non_https(monkeypatch):
    monkeypatch.setattr("shared.ssrf.socket.getaddrinfo", _fake_getaddrinfo(["8.8.8.8"]))
    with pytest.raises(ValueError, match="https"):
        assert_source_url_allowed("http://example.com/x")


def test_rejects_loopback(monkeypatch):
    monkeypatch.setattr("shared.ssrf.socket.getaddrinfo", _fake_getaddrinfo(["127.0.0.1"]))
    with pytest.raises(ValueError, match="non-public"):
        assert_source_url_allowed("https://example.com/x")


@pytest.mark.parametrize("ip", ["10.0.0.2", "192.168.1.5", "172.16.0.1", "169.254.1.1"])
def test_rejects_private_and_link_local(monkeypatch, ip):
    monkeypatch.setattr("shared.ssrf.socket.getaddrinfo", _fake_getaddrinfo([ip]))
    with pytest.raises(ValueError, match="non-public"):
        assert_source_url_allowed("https://example.com/x")


def test_rejects_mixed_public_and_private(monkeypatch):
    monkeypatch.setattr(
        "shared.ssrf.socket.getaddrinfo", _fake_getaddrinfo(["8.8.8.8", "10.0.0.2"])
    )
    with pytest.raises(ValueError, match="non-public"):
        assert_source_url_allowed("https://example.com/x")


def test_rejects_literal_private_host(monkeypatch):
    monkeypatch.setattr("shared.ssrf.socket.getaddrinfo", _fake_getaddrinfo(["127.0.0.1"]))
    with pytest.raises(ValueError):
        assert_source_url_allowed("https://127.0.0.1/x")
