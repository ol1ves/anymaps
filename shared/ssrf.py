"""SSRF safety rules (SPEC 10.8): https only, no private, loopback, or reserved IPs.

The generic server's poller and the Agent Service's source test both use these
rules. Service-to-service calls inside the deployment (for example the Agent
Service publishing to the generic server) do not go through this gate.

The caller must re-apply this check after every HTTP redirect.
"""

import ipaddress
import socket
from urllib.parse import urlparse


def _is_public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def assert_source_url_allowed(url: str) -> None:
    """Raise ValueError unless url is https and resolves only to public IPs."""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("only https URLs are allowed")
    host = parsed.hostname
    if host is None:
        raise ValueError("URL has no host")
    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise ValueError(f"cannot resolve host: {host}") from exc
    ips = {info[4][0] for info in infos}
    if not ips:
        raise ValueError(f"cannot resolve host: {host}")
    blocked = [ip for ip in ips if not _is_public_ip(ip)]
    if blocked:
        raise ValueError(f"host {host} resolves to a non-public IP: {blocked[0]}")
