"""Public API probe, separate from mandatory SSH release verification."""
import json
import sys
import urllib.error
import urllib.request


def classify(status, headers, body):
    headers = {key.lower(): value for key, value in headers.items()}
    if status == 200:
        try:
            data = json.loads(body)
            if isinstance(data, dict) and data.get('ok') is True:
                return 'ok'
        except (ValueError, UnicodeError):
            pass
    if (status == 403 and headers.get('cf-ray')
            and headers.get('cf-mitigated', '').lower() == 'challenge'):
        return 'challenge'
    raise ValueError(f'Public API smoke failed: HTTP {status}, cf-mitigated={headers.get("cf-mitigated", "none")}')


def main(url):
    request = urllib.request.Request(url, headers={'User-Agent':'AYA-Deployment-Smoke/1.0'})
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        result = classify(response.code, dict(response.headers), response.read(1_000_000))
    if result == 'challenge':
        print('::warning::Cloudflare challenged the CI runner; public API reachability is inconclusive. Source checksums, running container image and loopback health were verified separately over SSH.')
    else:
        print('PUBLIC_API_OK: expected health JSON returned')


if __name__ == '__main__':
    main(sys.argv[1])
