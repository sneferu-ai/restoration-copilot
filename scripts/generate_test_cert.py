#!/usr/bin/env python3
"""Self-signed certificate generator for HTTPS dev testing (FR-063).

``launch-dev.sh --https`` uses this to enable Service Worker registration and
screen wake-lock on localhost. For production phone access a TRUSTED
certificate is required (self-signed is rejected by mobile browsers for
Service Worker registration) — see the §8 production HTTPS checklist.
"""

from __future__ import annotations

import datetime
import ipaddress
import sys
from pathlib import Path


def generate(out_dir: Path) -> tuple:
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        print("cryptography package required: pip install cryptography", file=sys.stderr)
        raise SystemExit(2)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Restoration Copilot (dev)"),
        ]
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName("localhost"),
                    x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                    x509.IPAddress(ipaddress.IPv6Address("::1")),
                ]
            ),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    cert_path = out_dir / "dev-cert.pem"
    key_path = out_dir / "dev-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    return cert_path, key_path


def main() -> int:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("state/https")
    cert_path, key_path = generate(out_dir)
    print(f"dev certificate: {cert_path}\ndev key: {key_path}")
    print("NOTE: self-signed — accepted for localhost dev only. Mobile browsers")
    print("reject self-signed certs for Service Worker registration (FR-063).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
