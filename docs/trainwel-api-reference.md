# Trainwel / Humanagement API Reference

A practical reference for calling the Trainwel knowledge base API. Trainwel's
product is branded "Humanagement" and the backend is hosted under that name.

**Provenance and trust level.** This was reverse-engineered from a browser
capture (HAR) of the Trainwel web app plus live testing of a minted API token.
Everything about reads (GET), URL structure, auth, pagination, and response
shapes is grounded in actual captured traffic and is reliable. Write payloads,
the exact create endpoint, the publish mechanism, attachment upload, and rate
limits were NOT in the capture and are marked **UNVERIFIED** below. Do not build
write logic on the unverified sections without capturing a real request first.

---

## At a glance

| Item | Value |
|---|---|
| Base URL | `https://humanagement.herokuapp.com` |
| Backend | Django REST Framework (DRF), hosted on Heroku |
| Auth | `Authorization: Token <key>` (minted in Trainwel settings) |
| Content type | `application/json` |
| Trailing slash | **Required** on every path (missing slash returns 301) |
| Pagination | DRF page-number: `{count, next, previous, results}` |
| Dates | String `MM-DD-YYYY HH:MM:SS`, 24-hour (not ISO 8601) |
| Field naming | snake_case |

---

## Base URL

```
https://humanagement.herokuapp.com
```

All documented endpoints live under module namespaces: `/<module>/api/<resource>/`.
The knowledge base module (`/knowledgebase/api/...`) is the relevant one for
articles, categories, drafts, types, and tags.

---

## Authentication

Mint an API token in Trainwel's settings UI. Send it on every request as an
`Authorization` header using the DRF **Token** scheme:

```
Authorization: Token <your-key>
```

Notes:
- The scheme is `Token`, not `Bearer`. This was confirmed by live testing: the
  `Token` scheme authenticated successfully on the first call. If a future
  deployment rejects it with 401, `Bearer` would be the fallback to try, but
  `Token` is the confirmed working scheme today.
- The web app itself authenticates by session cookie, so the captured traffic
  carried no `Authorization` header. The token path above was validated
  separately against the live API, not read from the capture.
- Store the key as a server-side secret or environment variable. Never place it
  in client code, a URL, or a committed file.

---

## Request conventions

**Trailing slash is mandatory.** `.../detail-update/17` returns a 301 redirect to
`.../detail-update/17/`. Always include the trailing slash to avoid a redirect on
every call. Preserve any query string when you append the slash.

**Content type.** Responses are `application/json` for API calls. Send
`Content-Type: application/json` and `Accept: application/json`.

**Field naming is snake_case** throughout.

**Foreign keys appear twice.** A related object is often returned both as a bare
integer ID and as an expanded object with an `_info` suffix. For example an
article has both `article_category` (int) and `article_category_info` (object),
and both `type` (int) and `type_info` (object). Write the bare int; read either.

**Dates are strings, not ISO.** Format is `MM-DD-YYYY HH:MM:SS` in 24-hour time,
for example `08-18-2025 16:14:14`. Parse accordingly; do not assume ISO 8601. The
time zone is not specified in the payload.

---

## Pagination

List endpoints use DRF page-number pagination and return this envelope:

```json
{
  "count": 8,
  "next": "https://humanagement.herokuapp.com/knowledgebase/api/draft-articles/?page=2",
  "previous": null,
  "results": [ ... ]
}
```

- `next` is a full, ready-to-use URL (or `null` on the last page). Follow it
  verbatim until it is `null` to collect every record.
- Request pages with `?page=N`. Page size can be set on some endpoints with
  `?page_size=N`.
- Many endpoints accept `?paginate=false` to return a bare JSON array instead of
  the envelope. A few endpoints return a bare array by default (for example the
  article `simple-list` and `article-types`). A robust client should handle both:
  if the response is a list, treat it as a single page; if it is a dict with
  `results`, follow `next`.
- Some list endpoints (`list-create`, `definitions-create`) additionally accept
  ag-Grid server-side row-model params: `filterModel`, `rowGroupCols`,
  `groupKeys`, `ordering`, alongside `page` and `page_size`. You can ignore these
  for simple pulls.

---

## Rate limits

**UNVERIFIED.** No `X-RateLimit-*` or `Retry-After` headers appeared on any 200
response in the capture. DRF only emits `Retry-After` on an actual 429, so the
ceiling is unknown. Treat limits as undiscovered: add exponential backoff and
honor `Retry-After` on any 429, and probe cautiously if you plan high volume.

---

## Endpoint reference

Verbs listed are from each endpoint's `Allow` header (what the server permits),
not only what was exercised. "Read" rows are fully verified. "Write" verbs
(POST/PUT/PATCH/DELETE) are permitted by the server but their payloads were not
captured; treat payload details as UNVERIFIED.

### Knowledge base (primary)

| Path (under base URL) | Methods | Purpose | Key query params |
|---|---|---|---|
| `/knowledgebase/api/category/simple-list/` | GET | Lightweight category list | |
| `/knowledgebase/api/category/list-create/` | GET, POST | List categories / create a category | `simple` |
| `/knowledgebase/api/category-with-articles/` | GET | Category tree with embedded articles (truncated, see quirks) | `page`, `paginate`, `show_all`, `subsection`, `tab`, `hide_articles_for_subsections`, `kb_list`, `remove_uncategorized` |
| `/knowledgebase/api/simple-list/` | GET, POST | Flat article list `{id, title}` for a category | `article_category`, `paginate`, `simple_details` |
| `/knowledgebase/api/list-create/` | GET, POST | Full article list (ag-Grid) / likely create-article | `title`, `ordering`, `page`, `page_size`, `paginate`, `filterModel`, `rowGroupCols`, `groupKeys` |
| `/knowledgebase/api/retrieve-update-delete/{id}/` | GET, PUT, PATCH, DELETE | Single-article read / update / delete | `display_only`, `highlight_body_changes`, `show_previous_version_if_draft` |
| `/knowledgebase/api/draft-articles/` | GET | List draft (unpublished) articles | `title`, `ordering`, `page`, `page_size` |
| `/knowledgebase/api/article-types/` | GET, POST | List / create article types | |
| `/knowledgebase/api/article-tags-in-use/` | GET | Tags currently in use | |
| `/knowledgebase/api/definitions-create/` | GET, POST | Glossary definitions list / create | `title`, `ordering`, `page`, `page_size`, ag-Grid params |
| `/knowledgebase/api/acknowledgements/` | GET, POST | Article acknowledgements (who signed off) | `article_id`, `compressed`, `paginate` |
| `/knowledgebase/api/employee-article-read-activity/{id}/` | GET | Read activity for one article | |

### Account / other (peripheral)

| Path | Methods | Purpose |
|---|---|---|
| `/account/api/vigil-context/` | GET | Current user + company context; includes `mcp_enabled`, `mcp_scope`, `vigil_chat_enabled`. Useful as a cheap auth/health check. |
| `/company/api/detail-update/{id}/` | GET, PUT, PATCH | Company settings record |
| `/integrations/api/google-drive/status/` | GET | Google Drive integration status |
| `/subscription/api/my-subscription/` | GET | Billing / subscription (Chargebee data) |
| `/actions/api/activity-events/` | POST | Frontend telemetry (ignore) |

---

## Common recipes

**List every category (flat, with names and nesting):**
```
GET /knowledgebase/api/category/list-create/
```
Returns id, `category` (name), `is_subsection`, `parent_id`, `direct_articles_count`,
`articles_count`. Subsections are their own entries linked by `parent_id`.

**List a category's articles (titles only):**
```
GET /knowledgebase/api/simple-list/?article_category=<category_id>&simple_details=true&paginate=false
```
Returns a bare array of `{id, title}`.

**Get one article with full body:**
```
GET /knowledgebase/api/retrieve-update-delete/<id>/?display_only=true
```
Returns the full article including `body` (HTML). See shape below.

**List drafts (not shown by the standard lists):**
```
GET /knowledgebase/api/draft-articles/
```

**Confirm auth is working:**
```
GET /account/api/vigil-context/
```

---

## Response shapes

### Pagination envelope
`count` (int), `next` (url or null), `previous` (url or null), `results` (array).

### Category object (from `category-with-articles`)
```
id                     int
category               str    (the category name)
articles_count         int    (total incl. subsections)
direct_articles_count  int    (direct only)
is_subsection          bool
parent_id              int or null
kbarticle_set          array  (embedded articles, TRUNCATED, see quirks)
has_more               bool   (true if kbarticle_set was truncated)
subcategories          array
sections               array
```

### Article, simple list (`simple-list`)
```
id     int
title  str
```

### Article, full detail (`retrieve-update-delete/{id}/?display_only=true`)
```
id                          int
title                       str
body                        str    (HTML; inline images/videos live here)
status                      str    ("Publish" when live; draft value UNVERIFIED)
slug                        str or null
author                      str
version                     int
published_on                str    (MM-DD-YYYY HH:MM:SS)
last_edited_on              str    (MM-DD-YYYY HH:MM:SS)
company                     int
category_order              int
visibility                  int
universal                   bool
is_assigned_to_everyone     bool
is_question                 bool
has_read                    bool

# category + type (bare id and expanded _info)
article_category            int
article_category_info       object
type                        int
type_info                   object

# attachment-related (see Attachments section)
pdf_url                     str
file_url                    str
file_urls                   array
file_description            str or null
video_url                   str
video_uploaded              <null in sample>
google_drive_file_id        str
google_drive_mime_type      str
google_drive_file_name      str
google_drive_web_view_link  str

# assignment / acknowledgement
assigned_to                 null/obj
individuals                 array
assigned_responsibilities   array
assigned_positions          array
to_be_read_by               array
acknowledgement_type        null/str
acknowledgement_question    str
reassign_month_duration     int
reminder_frequency_days     int

# misc / usually empty
article_answers             array
found_definitions           array
used_in_courses             array
transcript                  null
flow_chart                  null
flow_chart_info             null
decision_chart              null
```

### Article type (inside `type_info`)
```
id                        int
type                      str
color                     str
description               str
is_default                bool
theme_header_html         str or null
theme_logo_url            str or null
theme_default_font_family str
theme_default_font_color  str
```

---

## Quirks and gotchas

1. **Trailing slash or 301.** Covered above. The single most common foot-gun.

2. **`Token`, not `Bearer`.** DRF TokenAuthentication scheme.

3. **Drafts are hidden from the standard lists.** `simple-list` and the normal
   article lists return published articles only. `direct_articles_count` on a
   category, however, counts some drafts, so the category's claimed count can
   exceed the number of articles the list returns. Use `/draft-articles/` to see
   unpublished ones. This mismatch is expected behavior, not a bug in your code.

4. **`category-with-articles` truncates.** Each category's embedded
   `kbarticle_set` is capped (around 5 articles) with `has_more: true` when more
   exist. Do not rely on it for a complete article list. For completeness, list
   categories first, then pull each category's articles via `simple-list`.

5. **Dates are `MM-DD-YYYY HH:MM:SS` strings**, not ISO. No timezone in payload.

6. **Foreign keys are doubled** (bare int plus `_info` object). Write the int.

7. **Publishing is probably a status change, not a separate endpoint.**
   Articles carry `status` ("Publish" when live), so going live is most likely a
   PATCH that sets `status`, and creating a draft most likely means sending the
   draft value of `status` on create. The exact draft value and field behavior
   are **UNVERIFIED** (no write traffic captured).

8. **Two endpoints accept POST for articles** (`list-create` and `simple-list`),
   so which one the "create article" action uses, and its payload, is
   **UNVERIFIED**. `list-create` is the more likely create endpoint by naming
   convention. Capture a real create to confirm.

9. **Server is Heroku**; responses include `X-Frame-Options: SAMEORIGIN` and
   `Via: 1.1 heroku-router`. No caching or rate-limit headers were present.

---

## Attachments

The read schema confirms attachments are supported, through three distinct
mechanisms, all reflected in the article fields above:

- **Direct file / PDF** hosted on Trainwel's own server (`file_url`, `file_urls`,
  `pdf_url`, `file_description`). In the sample, `pdf_url` pointed at a file on
  `humanagement.herokuapp.com`, so their backend stores uploaded files directly.
- **Video** (`video_url`, `video_uploaded`).
- **Google Drive linking** (`google_drive_file_id`, `google_drive_mime_type`,
  `google_drive_file_name`, `google_drive_web_view_link`), tied to the Google
  Drive integration endpoint.

**Inline images and videos** added through the article's rich-text editor are
embedded directly in the `body` HTML (as `<img>` tags or iframes), not stored as
separate attachment records. So when you read an article `body`, inline media
comes along as URL references inside the HTML, and on the read side needs no
extra handling.

**Upload mechanism: UNVERIFIED.** No upload, media, or presigned-URL request
appeared anywhere in the capture. The write path could be a direct multipart
POST, a presigned-URL two-step (request a slot, then PUT bytes to storage), or
the Google Drive reference flow. These require different client code. To build
uploads, capture one real attachment upload (and, separately, one inline-image
insert in the editor) with browser DevTools and inspect the full request
sequence, including any preliminary call that returns an upload URL or token.

---

## Summary of what is and is not verified

**Verified from captured traffic (reliable):** base URL, DRF stack, token auth
scheme, trailing-slash rule, pagination envelope and behavior, date format, field
naming and FK doubling, the full endpoint inventory with allowed verbs and query
params, and all read response shapes (categories, articles, article types).

**Unverified (capture one real request before relying on these):** all write
payloads (create / update / delete bodies), which endpoint create-article uses,
the publish and draft status mechanism, the attachment upload mechanism, and the
rate-limit ceiling.
