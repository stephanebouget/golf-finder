import json
import sys

MAX_BODY_CHARS = 3_000_000


def main():
    request = json.load(sys.stdin)

    try:
        if request["mode"] == "browser":
            from scrapling.fetchers import StealthyFetcher

            page = StealthyFetcher.fetch(
                request["url"],
                headless=True,
                timeout=request["timeoutMs"],
                extra_headers=request["headers"],
                solve_cloudflare=True,
            )
        else:
            from scrapling.fetchers import Fetcher

            page = Fetcher.get(request["url"], headers=request["headers"])

        status = int(page.status or 0)
        body = page.body
        if isinstance(body, bytes):
            body = body.decode(page.encoding or "utf-8", errors="replace")

        headers = {
            str(key).lower(): str(value)
            for key, value in (page.headers or {}).items()
        }
        print(
            json.dumps(
                {
                    "ok": 200 <= status < 400,
                    "status": status,
                    "finalUrl": str(getattr(page, "url", request["url"])),
                    "html": body[:MAX_BODY_CHARS],
                    "server": headers.get("server"),
                    "mitigated": headers.get("cf-mitigated"),
                }
            )
        )
    except Exception as error:
        print(
            json.dumps(
                {"error": str(error), "errorType": type(error).__name__}
            )
        )


if __name__ == "__main__":
    main()
