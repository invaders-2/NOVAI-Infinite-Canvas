from __future__ import annotations


class SplitError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def payload(self) -> dict:
        return {"ok": False, "error": {"code": self.code, "message": self.message}}
