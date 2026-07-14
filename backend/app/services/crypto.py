# app/services/crypto.py
import os, base64, hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from app.config import get_settings


def _key() -> bytes:
    h = get_settings().encryption_key
    if not h or len(h) != 64:
        raise ValueError("ENCRYPTION_KEY mora biti 64 hex karaktera")
    return bytes.fromhex(h)


def encrypt(plaintext: str) -> str | None:
    if not plaintext:
        return None
    iv  = os.urandom(12)
    ct  = AESGCM(_key()).encrypt(iv, plaintext.encode(), None)
    # ct[-16:] je GCM auth tag
    return (base64.b64encode(iv).decode() + "::" +
            base64.b64encode(ct[-16:]).decode() + "::" +
            base64.b64encode(ct[:-16]).decode())


def decrypt(ciphertext: str) -> str | None:
    if not ciphertext:
        return None
    parts = ciphertext.split("::")
    if len(parts) != 3:
        raise ValueError("Neispravan format")
    iv  = base64.b64decode(parts[0])
    tag = base64.b64decode(parts[1])
    ct  = base64.b64decode(parts[2])
    return AESGCM(_key()).decrypt(iv, ct + tag, None).decode()


def ssh_fingerprint(pub: str) -> str | None:
    try:
        b64 = pub.strip().split()[1]
        d   = hashlib.sha256(base64.b64decode(b64)).digest()
        return "SHA256:" + base64.b64encode(d).decode().rstrip("=")
    except Exception:
        return None
