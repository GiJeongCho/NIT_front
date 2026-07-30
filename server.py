"""
server.py — NIT_train_front 정적 서버

빌드 도구도 npm 도 쓰지 않는다. 온프레미스(폐쇄망) 배포에서 `npm install` 이
불가능한 경우가 많고, 이 화면은 프레임워크 없이도 충분히 만들 수 있기 때문이다.
따라서 배포는 "이 폴더를 정적 서빙" 하나로 끝난다.

표준 라이브러리만 쓴다. 파이썬이 없는 환경이면 nginx 로 이 폴더를 서빙해도 동작한다.

실행::

    python NIT_train_front/server.py                # http://127.0.0.1:8890
    python NIT_train_front/server.py --port 9000
    python NIT_train_front/server.py --api http://10.0.0.5:8888

`--api` 를 주면 `index.html` 을 열 때 그 주소를 기본 API 로 심어준다(브라우저
localStorage 에 저장된 값이 있으면 그것이 우선한다). 지정하지 않으면 화면이
`현재 호스트:8888` 을 기본값으로 쓴다.
"""

from __future__ import annotations

import argparse
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(SimpleHTTPRequestHandler):
    """정적 파일 + 캐시 무효화 + SPA 폴백."""

    api_base = ""

    def end_headers(self) -> None:
        # 개발 중 JS 를 고쳤는데 브라우저가 옛 파일을 쓰는 사고를 막는다.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def send_head(self):
        # 해시 라우팅이므로 실제로는 index.html 만 요청되지만, 사용자가 경로를
        # 직접 치는 경우에도 앱이 뜨도록 없는 경로는 index.html 로 돌린다.
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not self.path.startswith("/assets/"):
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, fmt: str, *args) -> None:
        # 이미지 요청이 초당 수십 개라 기본 로그는 노이즈다. 오류만 남긴다.
        status = str(args[1]) if len(args) > 1 else ""
        if status.startswith(("4", "5")):
            super().log_message(fmt, *args)


def main() -> int:
    ap = argparse.ArgumentParser(description="NIT_train_front 정적 서버")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.getenv("NIT_FRONT_PORT", "8890")))
    ap.add_argument("--api", default=os.getenv("NIT_TRAIN_API", ""),
                    help="학습 API 주소 (예: http://127.0.0.1:8888)")
    ap.add_argument("--write-only", action="store_true",
                    help="--api 값만 심고 서버는 띄우지 않는다(도커 이미지 빌드 전 단계)")
    args = ap.parse_args()

    if args.api:
        # 배포 시 API 주소를 파일에 심는다(assets/js/api-base.js).
        # 프런트는 이 값을 기본값으로 읽고, 사용자가 설정 창에서 바꾼 값이 있으면 그것을 쓴다.
        (ROOT / "assets" / "js" / "api-base.js").write_text(
            "/** server.py --api 로 생성됨 */\n"
            f'export const INJECTED_API_BASE = "{args.api.rstrip("/")}";\n',
            encoding="utf-8",
        )
        print(f"[front] 기본 API 주소 주입: {args.api}")

    if args.write_only:
        if not args.api:
            print("[front] --write-only 는 --api 와 함께 써야 합니다")
            return 2
        return 0

    handler = partial(Handler, directory=str(ROOT))
    with ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        print(f"[front] NIT_train_front → http://{args.host}:{args.port}")
        print(f"[front] 정적 루트: {ROOT}")
        print("[front] Ctrl+C 로 종료")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[front] 종료")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
