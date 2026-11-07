"""Explicit Docker CLI fixtures; live release verification runs in Actions."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class RuntimeTests(unittest.TestCase):
    def run_fixture(self, mode):
        with tempfile.TemporaryDirectory() as folder:
            docker = Path(folder) / 'docker'
            docker.write_text('''#!/bin/sh
case "$*" in
  *State.Running*) [ "$FIXTURE" = stopped ] && echo false || echo true ;;
  "inspect "*) echo sha256:manifest ;;
  "image inspect "*)
    case "$*" in
      *latest*) [ "$FIXTURE" = mismatch ] && echo sha256:different || echo sha256:config ;;
      *) echo sha256:config ;;
    esac ;;
  "exec "*) [ "$FIXTURE" != missing ] ;;
  *) exit 99 ;;
esac
''')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=folder + os.pathsep + os.environ['PATH'], FIXTURE=mode)
            return subprocess.run(['sh', str(Path(__file__).with_name('verify-runtime.sh')), 'dev'], env=env, capture_output=True, text=True)

    def test_manifest_and_config_reference_same_image(self):
        self.assertEqual(self.run_fixture('same').returncode, 0)

    def test_different_running_image_fails(self):
        self.assertNotEqual(self.run_fixture('mismatch').returncode, 0)

    def test_stopped_container_fails(self):
        self.assertNotEqual(self.run_fixture('stopped').returncode, 0)

    def test_missing_entry_point_fails(self):
        self.assertNotEqual(self.run_fixture('missing').returncode, 0)


if __name__ == '__main__':
    unittest.main()
