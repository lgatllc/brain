#!/usr/bin/env python3
"""Local stand-in for the GitHub Git Data API and the owner-notification webhook.

Used only by tests/smoke.sh. Usage: mock-services.py <port> <log-file>
"""
import http.server
import json
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9911
LOG = open(sys.argv[2] if len(sys.argv) > 2 else "mock.log", "a")


def note(line):
    LOG.write(line + "\n")
    LOG.flush()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()

    def do_GET(self):
        note(f"GET {self.path}")
        if self.path.endswith("/git/ref/heads/main"):
            return self.reply(200, {"object": {"sha": "c0"}})
        if "/git/commits/" in self.path:
            return self.reply(200, {"tree": {"sha": "t0"}})
        self.reply(404, {})

    def do_POST(self):
        body = self.read_body()
        if self.path.endswith("/git/trees"):
            data = json.loads(body)
            note(f"TREE {len(data['tree'])} entries base={data['base_tree']}")
            for entry in data["tree"]:
                if entry.get("content") is not None:
                    note(f"FILE {entry['path']} schema={'yes' if 'schema_version' in entry['content'] else 'no'}")
            return self.reply(201, {"sha": "t1"})
        if self.path.endswith("/git/commits"):
            note(f"COMMIT {json.loads(body)['message']}")
            return self.reply(201, {"sha": "c1abcdef"})
        note(f"POST {self.path} {body[:300]}")
        if "force-notify-fail" in body:  # lets the smoke test force a failed notification
            return self.reply(500, {})
        self.reply(200, {})

    def do_PATCH(self):
        note(f"PATCH {self.path} {self.read_body()}")
        self.reply(200, {})


http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
