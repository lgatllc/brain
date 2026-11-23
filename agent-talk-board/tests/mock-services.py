#!/usr/bin/env python3
"""Local stand-in for the GitHub Git Data API and the owner-notification webhook.

Used only by tests/smoke.sh. Usage: mock-services.py <port> <log-file>
"""
import http.server
import json
import re
import sys
import urllib.parse

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


DESC = {}
CKL = {"c1": [{"id": "cl1", "name": "Steps", "checkItems": [{"id": "ci1", "name": "Sign it", "state": "complete"}, {"id": "ci2", "name": "Mail it", "state": "incomplete"}]}]}
COMMENTS = {}
LABELS = [{"id": "lb1", "name": "urgent"}, {"id": "lb2", "name": "waiting"}]
COUNTER = {"n": 0}


def card_detail(c):
    d = dict(c)
    d["desc"] = DESC.get(c["id"], "ZZDESC call the vendor about the contract")
    d["idLabels"] = [l["id"] for l in LABELS if l["name"] in [x["name"] for x in c["labels"]]]
    d["shortUrl"] = "https://trello.com/c/" + c["shortLink"]
    d["board"] = {"name": BOARD_NAMES[c["idBoard"]]}
    d["list"] = {"name": next(l["name"] for l in LISTS[c["idBoard"]] if l["id"] == c["idList"])}
    d["checklists"] = CKL.get(c["id"], [])
    d["actions"] = [{"date": "2026-11-19T09:30:00.000Z", "data": {"text": t}, "memberCreator": {"fullName": "Owner"}} for t in COMMENTS.get(c["id"], [])]
    if c["id"] == "c1":
        d["actions"].append({"date": "2026-11-19T09:30:00.000Z", "data": {"text": "ZZCOMMENT waiting on the vendor"}, "memberCreator": {"fullName": "Owner"}})
    return d


# Stand-in for Trainwel's knowledge base API (shapes from docs/trainwel-api-reference.md). POST /__trainwel/<normal|changed|down|unauthorized> switches it.
TW = {"v": "normal"}
TW_D = {"title": "Draft: expense policy", "body": "<p>Draft text about expenses.</p>", "edited": "11-20-2026 10:00:00"}
TW_V = {"ver": 1, "body": "<p>Fifteen days of leave.</p>"}
TW_CATS = [{"id": 1, "category": "HR", "direct_articles_count": 2, "parent_id": None}, {"id": 2, "category": "Operations", "direct_articles_count": 1, "parent_id": None}, {"id": 3, "category": "Empty", "direct_articles_count": 0, "parent_id": None}]
TW_LISTS = {"1": [{"id": 11, "title": "Onboarding checklist"}, {"id": 12, "title": "Time off policy"}], "2": [{"id": 21, "title": "Month-end close steps"}, {"id": 22, "title": "Vendor logins"}, {"id": 23, "title": "Shared mailbox"}, {"id": 26, "title": "Reviewed token note"}]}
TW_ARTICLE = {
    "id": 11, "title": "Onboarding checklist", "status": "Publish", "version": 3, "author": "Pat", "published_on": "08-18-2025 16:14:14", "last_edited_on": "09-01-2025 09:00:00",
    "article_category": 1, "article_category_info": {"id": 1, "category": "HR"}, "pdf_url": "https://humanagement.herokuapp.com/media/onboarding.pdf",
    "body": "<h2>Day one</h2><p>Welcome &amp; hello.<br>Read <a href=\"https://example.com/policy\">the policy</a>.</p><ul><li>Collect forms</li><li>Set up email</li></ul><img src=\"https://example.com/a.png\" alt=\"desk\"><script>ZZSCRIPT()</script>",
}


def tw_write(handler, method, path, body):
    ok_auth = handler.headers.get("Authorization") == "Token key-tw"
    note(f"TRAINWEL {method} {path} auth={'yes' if ok_auth else 'no'}")
    if not ok_auth:
        return handler.reply(401, {"detail": "Invalid token."})
    if method == "POST" and path == "/knowledgebase/api/draft-article-create/":
        field = lambda n: (re.search('name="%s"\r\n\r\n(.*?)\r\n--' % n, body, re.S) or [None, ""])[1]
        if "Bad title" in field("title"):
            return handler.reply(400, {"title": ["not allowed"]})
        note("TRAINWEL CREATED category=%s title=%s body=%s" % (field("article_category"), field("title"), field("body")))
        return handler.reply(201, {"id": 41, "title": field("title"), "status": 1})
    if method == "PATCH" and path == "/knowledgebase/api/draft-articles/31/":
        j = json.loads(body or "{}")
        note("TRAINWEL PATCHED status=%s notify=%s title=%s body=%s" % (j.get("status"), j.get("dont_notify"), j.get("title"), j.get("body")))
        if "title" in j:
            TW_D["title"] = j["title"]
        if "body" in j:
            TW_D["body"] = j["body"]
        TW_D["edited"] = "11-20-2026 12:00:00"
        return handler.reply(200, {"id": 9031 if j.get("status") == 0 else 31, "title": TW_D["title"]})
    if method == "PATCH" and path == "/knowledgebase/api/retrieve-update-delete/21/":
        j = json.loads(body or "{}")
        note("TRAINWEL PATCHED21 status=%s notify=%s title=%s body=%s" % (j.get("status"), j.get("dont_notify"), j.get("title"), j.get("body")))
        return handler.reply(200, {"id": 21, "title": "Month-end close steps"})
    return handler.reply(404, {})


def tw_reply(handler, path):
    base = "http://" + handler.headers["Host"] + "/trainwel"
    ok_auth = handler.headers.get("Authorization") == "Token key-tw" and TW["v"] != "unauthorized"
    note(f"TRAINWEL GET {path} auth={'yes' if ok_auth else 'no'}")
    if not ok_auth:
        return handler.reply(401, {"detail": "Invalid token."})
    if TW["v"] == "down":
        return handler.reply(500, {})
    route, _, qs = path.partition("?")
    if route == "/knowledgebase/api/category/list-create/":
        return handler.reply(200, {"oops": 1} if TW["v"] == "changed" else TW_CATS)
    if route == "/knowledgebase/api/simple-list/":
        cat = qs.split("article_category=")[1].split("&")[0]
        return handler.reply(200, TW_LISTS.get(cat, []))
    if route == "/knowledgebase/api/draft-articles/":
        if "page=2" in qs:
            return handler.reply(200, {"count": 2, "next": None, "previous": base + route, "results": [{"id": 32, "title": "Draft: travel"}]})
        return handler.reply(200, {"count": 2, "next": base + route + "?page=2", "previous": None, "results": [{"id": 31, "title": "Draft: expense policy"}]})
    if route == "/knowledgebase/api/draft-articles/31/":
        return handler.reply(200, {"id": 31, "title": TW_D["title"], "status": 1, "article_category_info": {"id": 1, "category": "Finance"}, "body": TW_D["body"], "last_edited_on": TW_D["edited"]})
    if route == "/knowledgebase/api/draft-articles/34/":
        return handler.reply(200, {"id": 34, "title": "Draft with picture", "status": 1, "body": "<p>See below</p><img src=\"https://e.com/x.png\">", "last_edited_on": "11-20-2026 11:00:00"})
    if route == "/knowledgebase/api/draft-articles/32/":
        return handler.reply(403, {"detail": "You do not have permission to perform this action."})
    if route == "/knowledgebase/api/retrieve-update-delete/11/":
        return handler.reply(200, {"title": "no id here"} if TW["v"] == "changed" else TW_ARTICLE)
    if route in ("/knowledgebase/api/retrieve-update-delete/12/", "/knowledgebase/api/retrieve-update-delete/21/"):
        n = 12 if route.endswith("/12/") else 21
        return handler.reply(200, {"id": n, "title": "Time off policy" if n == 12 else "Month-end close steps", "version": TW_V["ver"] if n == 12 else 1, "last_edited_on": "09-01-2025 09:00:00", "body": TW_V["body"] if n == 12 else "<p>Close the books.</p>"})
    if route == "/knowledgebase/api/retrieve-update-delete/25/":
        signed = "https://bucket.s3.amazonaws.com/media/long.pdf?X-Amz-Credential=AKIAZZSIGNEDKEYID%2F20261120&X-Amz-Signature=zzsig"
        return handler.reply(200, {"id": 25, "title": "A very long article", "version": 1, "pdf_url": signed, "body": '<p><a href="' + signed.replace("&", "&amp;") + '">the file</a></p>' + "".join("<p>Line %05d of the long article.</p>" % i for i in range(1500))})
    if route == "/knowledgebase/api/retrieve-update-delete/28/":
        return handler.reply(403, {"detail": "You do not have permission to perform this action."})
    if route == "/knowledgebase/api/retrieve-update-delete/26/":
        return handler.reply(200, {"id": 26, "title": "Reviewed token note", "version": 1, "body": "<p>ZZREVIEWED id sk-abcdefghijklmnopqrstuvwxyz0123 is a public sample id.</p>"})
    if route == "/knowledgebase/api/retrieve-update-delete/22/":
        return handler.reply(200, {"id": 22, "title": "Vendor logins", "body": "<p>ZZPASSWORD hunter2</p>"})
    if route == "/knowledgebase/api/retrieve-update-delete/23/":
        return handler.reply(200, {"id": 23, "title": "Shared mailbox", "body": "<p>ZZKEYTEXT sk-abcdefghijklmnopqrstuvwxyz0123</p>"})
    if route.startswith("/knowledgebase/api/retrieve-update-delete/"):
        return handler.reply(404, {"detail": "Not found."})
    if route == "/account/api/vigil-context/":
        return handler.reply(200, {"mcp_enabled": True, "mcp_scope": "read", "vigil_chat_enabled": False, "user": {"email": "private@example.com"}})
    return handler.reply(404, {})


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

    def trello_write(self, method):
        path, _, qs = self.path.partition("?")
        params = {k: v[0] for k, v in urllib.parse.parse_qs(qs).items()}
        parts = path.split("/")  # ["", "trello", "1", "cards", "c1", ...]
        note(f"TRELLOW {method} {'/'.join(parts[3:])} {sorted(params.items())}")
        if TRELLO["v"] == "down":
            return self.reply(500, {})
        if method == "POST" and parts[3:] == ["cards"]:
            COUNTER["n"] += 1
            i = f"n{COUNTER['n']}"
            board = next(b for b, ls in LISTS.items() if any(l["id"] == params["idList"] for l in ls))
            labels = [{"name": l["name"], "color": "red"} for l in LABELS if l["id"] in params.get("idLabels", "").split(",")]
            CARDS[i] = mk_card(i, board, params["idList"], params["name"], params.get("due"), "2026-11-19T12:00:00.000Z", [], "Nn%02d00Zz" % COUNTER["n"])
            CARDS[i]["labels"] = labels
            DESC[i] = params.get("desc", "")
            return self.reply(200, {"id": i, "shortUrl": "https://trello.com/c/" + CARDS[i]["shortLink"]})
        if len(parts) >= 5 and parts[3] == "cards" and parts[4] not in CARDS and not any(x["shortLink"] == parts[4] for x in CARDS.values()):
            return self.reply(404, {})
        card = CARDS.get(parts[4]) if len(parts) > 4 and parts[3] == "cards" else None
        if method == "PUT" and len(parts) == 5 and card:
            for k in ("name", "idList", "due"):
                if k in params:
                    card[k] = None if params[k] == "null" else params[k]
            if "desc" in params:
                DESC[card["id"]] = params["desc"]
            if "closed" in params:
                card["closed"] = params["closed"] == "true"
            if "dueComplete" in params:
                card["dueComplete"] = params["dueComplete"] == "true"
            if "idLabels" in params:
                ids = params["idLabels"].split(",")
                card["labels"] = [{"name": l["name"], "color": "red"} for l in LABELS if l["id"] in ids]
            return self.reply(200, {"id": card["id"]})
        if method == "DELETE" and len(parts) == 5 and card:
            CARDS.pop(card["id"], None)
            return self.reply(200, {})
        if method == "POST" and len(parts) == 7 and parts[5:] == ["actions", "comments"] and card:
            COMMENTS.setdefault(card["id"], []).append(params["text"])
            return self.reply(200, {"id": "act1"})
        if method == "POST" and parts[3:] == ["checklists"]:
            cl = {"id": "cl%d" % (len(CKL) + 10), "name": params["name"], "checkItems": []}
            CKL.setdefault(params["idCard"], []).append(cl)
            return self.reply(200, {"id": cl["id"], "name": cl["name"]})
        if method == "POST" and len(parts) == 6 and parts[3] == "checklists" and parts[5] == "checkItems":
            for lists in CKL.values():
                for cl in lists:
                    if cl["id"] == parts[4]:
                        cl["checkItems"].append({"id": "ci%d" % (len(cl["checkItems"]) + 20), "name": params["name"], "state": "incomplete"})
                        return self.reply(200, {})
            return self.reply(404, {})
        if method == "PUT" and len(parts) == 7 and parts[5] == "checkItem" and card:
            for cl in CKL.get(card["id"], []):
                for it in cl["checkItems"]:
                    if it["id"] == parts[6]:
                        it["state"] = params["state"]
                        return self.reply(200, {})
            return self.reply(404, {})
        return self.reply(404, {})

    def do_PUT(self):
        self.read_body()
        if self.path.startswith("/trello/1/"):
            return self.trello_write("PUT")
        self.reply(404, {})

    def do_DELETE(self):
        self.read_body()
        if self.path.startswith("/trello/1/"):
            return self.trello_write("DELETE")
        self.reply(404, {})

    def do_GET(self):
        note(f"GET {self.path}")
        if self.path.startswith("/trainwel/"):
            return tw_reply(self, self.path[len("/trainwel"):])
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
            if len(parts) == 5 and parts[3] == "lists":
                for b, ls in LISTS.items():
                    for l in ls:
                        if l["id"] == parts[4]:
                            return self.reply(200, {"id": l["id"], "name": l["name"], "idBoard": b, "board": {"name": BOARD_NAMES[b]}})
                return self.reply(404, {})
            if len(parts) == 6 and parts[3] == "boards" and parts[5] == "labels":
                return self.reply(200, LABELS)
            if len(parts) == 6 and parts[3] == "cards" and parts[5] == "checklists":
                return self.reply(200, CKL.get(parts[4], []))
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
        if self.path.startswith("/trainwel/"):
            return tw_write(self, "POST", self.path[len("/trainwel"):], body)
        if self.path.startswith("/trello/1/"):
            return self.trello_write("POST")
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
            elif action == "add":
                CARDS[card] = mk_card(card, "b2", "m1", "CRM thing", None, "2026-11-19T08:30:00.000Z", [], "Zz00Yy11")
            elif action == "rename":
                CARDS[card]["name"] = parts[4].replace("_", " ")
            return self.reply(200, {})
        if self.path.startswith("/__trainwel/"):
            name = self.path.rsplit("/", 1)[1]
            if name == "edit12":  # the article changes in Trainwel
                TW_V["ver"] = 2
                TW_V["body"] = "<p>Twenty days of leave.</p>"
            else:
                TW["v"] = name
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
        if self.path.startswith("/trainwel/"):
            return tw_write(self, "PATCH", self.path[len("/trainwel"):], self.read_body())
        note(f"PATCH {self.path} {self.read_body()}")
        self.reply(200, {})


http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
