import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('public_smoke', Path(__file__).with_name('public-smoke.py'))
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublicSmokeTests(unittest.TestCase):
    def test_healthy_api_passes(self):
        self.assertEqual(module.classify(200, {}, b'{"ok":true}'), 'ok')

    def test_explicit_cloudflare_challenge_is_distinct(self):
        self.assertEqual(module.classify(403, {'cf-mitigated':'challenge','cf-ray':'test'}, b'challenge'), 'challenge')

    def test_generic_403_must_fail(self):
        with self.assertRaises(ValueError):
            module.classify(403, {'cf-ray':'test'}, b'Forbidden')

    def test_server_error_must_fail(self):
        with self.assertRaises(ValueError):
            module.classify(503, {}, b'unavailable')

    def test_wrong_200_response_must_fail(self):
        for body in [b'<html>fallback</html>', b'{"ok":false}', b'{"ok":1}', b'[]']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                module.classify(200, {}, body)

    def test_spoofed_challenge_without_cloudflare_must_fail(self):
        with self.assertRaises(ValueError):
            module.classify(403, {'cf-mitigated':'challenge'}, b'Forbidden')


if __name__ == '__main__':
    unittest.main()
