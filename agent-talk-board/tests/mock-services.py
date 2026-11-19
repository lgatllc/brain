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


# Stand-in for Trello's API (members, boards, webhooks). The smoke test switches the state with POST /__trello/<mode>:
# healthy (a board webhook on each board and an account-level one), missing (the second board has none and there is no account-level one),
# broken (the second board's webhook is inactive and the account-level one is failing), newtoken (the asking token created none), down (HTTP 500).
TRELLO = {"v": "healthy"}
CALLBACK = "http://localhost:8793/hooks/trello"


def trello_hooks(mode):
    def hook(i, model, **extra):
        return {"id": i, "idModel": model, "callbackURL": CALLBACK, "active": True, "consecutiveFailures": 0, **extra}
    if mode == "newtoken":  # Trello lists only the webhooks the asking token created: a replaced token sees none
        return []
    if mode == "missing":
        return [hook("h1", "b1")]
    if mode == "broken":
        return [hook("h1", "b1"), hook("h2", "b2", active=False), hook("hm", "m1", consecutiveFailures=5)]
    return [hook("h1", "b1"), hook("h2", "b2"), hook("hm", "m1")]


# Boards, lists and cards for the awareness cache. POST /__trellocard/<move|close|delete|rename>/<card>[/<arg>] changes them.
LISTS = {
    "b1": [{"id": "l1", "name": "Planned", "pos": 1}, {"id": "l2", "name": "In Progress", "pos": 2}, {"id": "l3", "name": "Completed", "pos": 3}],
    "b2": [{"id": "m1", "name": "Planned", "pos": 1}],
}
BOARD_NAMES = {"b1": "Main", "b2": "CRM"}


def mk_card(i, board, lst, name, due, activity, labels, short):
    return {"id": i, "idBoard": board, "idList": lst, "name": name, "due": due, "dueComplete": False, "shortLink": short,
            "dateLastActivity": activity, "closed": False, "labels": [{"name": n, "color": "red"} for n in labels]}


CARDS = {
    "c1": mk_card("c1", "b1", "l1", "Send letter", "2026-11-25T12:00:00.000Z", "2026-11-19T10:00:00.000Z", ["urgent"], "Ab12Cd34"),
    "c2": mk_card("c2", "b1", "l2", "Call vendor", None, "2026-11-19T09:00:00.000Z", [], "Ef56Gh78"),
    "c3": mk_card("c3", "b2", "m1", "Update pipeline", None, "2026-11-19T08:00:00.000Z", [], "Ij90Kl12"),
}


def card_detail(c):
    d = dict(c)
    d["desc"] = "ZZDESC call the vendor about the contract"
    d["shortUrl"] = "https://trello.com/c/" + c["shortLink"]
    d["board"] = {"name": BOARD_NAMES[c["idBoard"]]}
    d["list"] = {"name": next(l["name"] for l in LISTS[c["idBoard"]] if l["id"] == c["idList"])}
    d["checklists"] = [{"name": "Steps", "checkItems": [{"name": "Sign it", "state": "complete"}, {"name": "Mail it", "state": "incomplete"}]}]
    d["actions"] = [{"date": "2026-11-19T09:30:00.000Z", "data": {"text": "ZZCOMMENT waiting on the vendor"}, "memberCreator": {"fullName": "Owner"}}]
    return d


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
        if self.path.startswith("/trello/1/"):
            auth = "yes" if self.headers.get("Authorization", "").startswith("OAuth oauth_consumer_key=") else "no"
            note(f"TRELLO {self.path.split('?')[0].split('/tokens/')[0]} auth={auth} mode={TRELLO['v']}")
            if TRELLO["v"] == "down":
                return self.reply(500, {})
            if self.path.startswith("/trello/1/members/me/boards"):
                return self.reply(200, [{"id": "b1", "name": "Main"}, {"id": "b2", "name": "CRM"}])
            if self.path.startswith("/trello/1/members/me"):
                return self.reply(200, {"id": "m1"})
            if "/webhooks" in self.path:
                return self.reply(200, trello_hooks(TRELLO["v"]))
            parts = self.path.split("?")[0].split("/")  # ["", "trello", "1", "boards", "b1", "lists"]
            if len(parts) == 6 and parts[3] == "boards" and parts[5] == "lists":
                return self.reply(200, LISTS.get(parts[4], []))
            if len(parts) == 6 and parts[3] == "boards" and parts[5] == "cards":
                return self.reply(200, [c for c in CARDS.values() if c["idBoard"] == parts[4] and not c["closed"]])
            if len(parts) == 5 and parts[3] == "cards":
                c = CARDS.get(parts[4]) or next((x for x in CARDS.values() if x["shortLink"] == parts[4]), None)  # Trello accepts either
                return self.reply(200, card_detail(c)) if c else self.reply(404, {})
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
        if self.path.startswith("/__trellocard/"):
            parts = self.path.split("/")  # ["", "__trellocard", action, card, arg]
            action, card = parts[2], parts[3]
            if action == "move":
                CARDS[card]["idList"] = parts[4]
                CARDS[card]["dateLastActivity"] = "2026-11-19T11:00:00.000Z"
            elif action == "close":
                CARDS[card]["closed"] = True
            elif action == "delete":
                CARDS.pop(card, None)
            elif action == "rename":
                CARDS[card]["name"] = parts[4].replace("_", " ")
            return self.reply(200, {})
        if self.path.startswith("/__trello/"):
            TRELLO["v"] = self.path.rsplit("/", 1)[1]
            return self.reply(200, {})
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
