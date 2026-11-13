#!/usr/bin/env python3
"""Local stand-in for the GitHub Git Data API and the owner-notification webhook.

Used only by tests/smoke.sh. Usage: mock-services.py <port> <log-file>
"""
import http.server
import json
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9911
LOG = open(sys.argv[2] if len(sys.argv) > 2 else "mock.log", "a")
JWKS = sys.argv[3] if len(sys.argv) > 3 else None  # public keys served as Cloudflare Access's /cdn-cgi/access/certs


def note(line):
    LOG.write(line + "\n")
    LOG.flush()


# Stand-in for Cloudflare's GraphQL Analytics API. The smoke test switches the reading with POST /__graphql/<level>.
LEVEL = {"v": "normal"}


def graphql_body(level):
    ops = [
        {"dimensions": {"actionType": "PutObject"}, "sum": {"requests": 100}},
        {"dimensions": {"actionType": "GetObject"}, "sum": {"requests": 9_300_000 if level == "high" else 1000}},
    ]
    payload = 9_000_000_000 if level == "full" else 1_000_000
    account = {
        "r2Ops": ops,
        "r2Storage": [{"max": {"payloadSize": payload, "metadataSize": 1000}}],
        "workers": [{"sum": {"requests": 50}}],
        "doInv": [{"sum": {"requests": 40}}],
        "doRows": [{"sum": {"rowsRead": 1000, "rowsWritten": 200}}],
        "kvOps": [{"dimensions": {"actionType": "read"}, "sum": {"requests": 5}}, {"dimensions": {"actionType": "write"}, "sum": {"requests": 2}}],
    }
    if level == "bad":
        account = {"r2Ops": []}
    return {"data": {"viewer": {"accounts": [account]}}}


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
        if self.path == "/access-certs" and JWKS:
            body = open(JWKS, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.endswith("/git/ref/heads/main"):
            return self.reply(200, {"object": {"sha": "c0"}})
        if "/git/commits/" in self.path:
            return self.reply(200, {"tree": {"sha": "t0"}})
        self.reply(404, {})

    def do_POST(self):
        body = self.read_body()
        if self.path == "/graphql":
            auth = "yes" if self.headers.get("Authorization", "").startswith("Bearer ") else "no"
            note(f"GRAPHQL auth={auth} level={LEVEL['v']}")
            return self.reply(200, graphql_body(LEVEL["v"]))
        if self.path.startswith("/__graphql/"):
            LEVEL["v"] = self.path.rsplit("/", 1)[1]
            return self.reply(200, {})
        if self.path.endswith("/git/trees"):
            data = json.loads(body)
            note(f"TREE {len(data['tree'])} entries base={data['base_tree']}")
            for entry in data["tree"]:
                if entry.get("content") is not None:
                    note(f"FILE {entry['path']} schema={'yes' if 'schema_version' in entry['content'] else 'no'}")
                    if "zq7canary" in entry["content"]:  # the redaction test's canary string
                        note(f"LEAK {entry['path']}")
                elif "sha" in entry and entry["sha"] is None:
                    note(f"DELETE {entry['path']}")
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
