"""Exercise the setup client against a local HTTP fixture, without accounts or models."""
import importlib.util
import json
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest

spec = importlib.util.spec_from_file_location('setup', Path(__file__).parents[1] / 'scripts/configure-workbench.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.state = {'sources': [{'id': 'workbench', 'revision': 2, 'value': {'enabled': False,
            'config': {'ownerId': '', 'domains': [{'id': 'research'}]}}}],
            'blocks': {'policy': {'revision': 7, 'value': {'rules': ['keep'],
                'sources': {'github': {'allowed': [{'id': 'existing'}]}}}}}}
        self.writes = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(200); self.end_headers()
                self.wfile.write(json.dumps(fixture.state).encode())

            def do_PUT(self):
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                fixture.writes.append((self.path, body))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{}')

        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.shutdown)

    def test_preserves_domains_and_other_policy_while_configuring_owner(self):
        setup.configure(self.server.server_port, 'owner')
        source, policy = [body for _path, body in self.writes]
        self.assertEqual(source['revision'], 2)
        self.assertEqual(source['value']['config']['domains'], [{'id': 'research'}])
        self.assertEqual(policy['revision'], 7)
        self.assertEqual(policy['value']['sources']['github'], {'allowed': [{'id': 'existing'}]})
        self.assertEqual(policy['value']['rules'], ['keep'])
        self.assertEqual(policy['value']['sources']['workbench']['allowed'], [{'id': 'owner'}])

    def test_refuses_another_owner_before_writing(self):
        self.state['sources'][0]['value']['config']['ownerId'] = 'someone-else'
        with self.assertRaisesRegex(ValueError, 'another owner'):
            setup.configure(self.server.server_port, 'owner')
        self.assertEqual(self.writes, [])

    def test_missing_plugin_does_not_write(self):
        self.state['sources'] = []
        with self.assertRaisesRegex(ValueError, 'Enable'):
            setup.configure(self.server.server_port, 'owner')
        self.assertEqual(self.writes, [])

    def test_repeated_setup_keeps_one_allowed_owner(self):
        self.state['blocks']['policy']['value']['sources']['workbench'] = {
            'allowed': [{'id': 'owner'}], 'admission': {}}
        setup.configure(self.server.server_port, 'owner')
        self.assertEqual(self.writes[-1][1]['value']['sources']['workbench']['allowed'], [{'id': 'owner'}])


if __name__ == '__main__':
    unittest.main()
