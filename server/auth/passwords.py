#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""口令哈希：hashlib.scrypt + 每用户随机盐。

存储格式 scrypt$n$r$p$salt_hex$dk_hex：参数随密文一起存，
将来调强参数时老用户仍能验证，不需要重置密码。
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
DKLEN = 32
SALT_BYTES = 16


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.scrypt(
        str(password).encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=DKLEN,
    )
    return "scrypt$%d$%d$%d$%s$%s" % (
        SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.hex(), digest.hex()
    )


def verify_password(password: str, stored: str) -> bool:
    """校验失败一律返回 False：格式损坏的旧记录不能把登录流程炸成 500。"""
    try:
        algorithm, n_raw, r_raw, p_raw, salt_hex, expected_hex = str(stored or "").split("$")
        if algorithm != "scrypt":
            return False
        expected = bytes.fromhex(expected_hex)
        digest = hashlib.scrypt(
            str(password).encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=int(n_raw),
            r=int(r_raw),
            p=int(p_raw),
            dklen=len(expected),
        )
    except Exception:
        return False
    return hmac.compare_digest(digest, expected)
