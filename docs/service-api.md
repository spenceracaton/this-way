# Listing service contract

The API is same-origin. JSON errors are `{error:{code,message,fields?}}`.
All time values are epoch milliseconds. Public DTOs omit private source metadata,
object keys, upload capabilities, and review notes. The small shared season
configuration is `public/season-config.mjs`.

- `GET /api/config`: `{available:true,season:{id,kind,year,name,tags,submissionTitle,themePlaceholder},limits:{photos:3,maxPhotoBytes:2097152}}`.
  An unbound Worker returns `available:false`; a static-only preview returns 404.
  Only those explicit states permit the existing illustrative demo. An error from
  an enabled API must not turn into fictional listings.
- `GET /api/listings?neighborhood=ID&season=ID`: `{listings:Listing[]}`; only published
  listings and approved photos. Listing fields: `id,locationId,seasonId,
  neighborhoodId,address,title,description,tags,customTags,latitude,longitude,
  status,version,createdAt,photos`. Photo fields:
  `id,url,mediaType,width,height,position,fit`.
- `GET /api/neighborhood-counts?season=ID`: `{season:ID,counts:{neighborhoodId:number}}`.
  Counts published listings in that season and includes every supported neighborhood,
  including zero counts. An unsupported season returns 400.
- `POST /api/reports`: `{clientRequestId,listingId,seasonId,reason,details?}`.
  Reasons: `incorrect-address`, `not-displayed`, `inappropriate`, `other`.
  The target must be published in the specified supported season. Details are at
  most 500 characters; an empty detail is allowed with a reason.
- `POST /api/feedback`: `{clientRequestId,seasonId,message,email?}`. A nonempty
  message is at most 1000 characters; an optional email is at most 254 characters.
  Both message endpoints reject unexpected fields and unsupported control characters,
  and accept at most 16KiB JSON. They return only `{recorded:true,id}` with 201 for
  a new message or 200 for an identical retry. Changed content reusing an ID is 409.
  Messages and emails are private. The visitor UI retains failed drafts and reuses
  the request ID when retrying unchanged content, prevents duplicate sends, and shows
  success only after the server confirms storage. Static demos remain previews.
- `POST /api/listings`: JSON `{clientRequestId,seasonId,neighborhoodId,address,
  title,description,tags,customTags?,latitude,longitude}`. A valid text/address
  listing is published immediately. Returns 201 `{listing,uploadToken}`; replaying
  the same request ID and content returns the same listing without duplication
  (200). Conflicting content is 409. The client generates and retains a UUID per
  submission intent. The returned capability is private and short-lived.
- `POST /api/listings/:id/photos`: binary JPEG/PNG/WebP body, matching Content-Type,
  `Authorization: Bearer uploadToken`, `X-Photo-Request-Id: UUID`. Response 201
  `{photo:{id,status:'pending',version:1}}`. The client first decodes/resizes and
  re-encodes to a maximum 1600px edge and 2MiB. The server validates and strips
  metadata again. Maximum three active/pending photos per listing. Replays with
  the same ID and bytes return the existing pending/approved/rejected record.
- `POST /api/listings/:id/photo-upload-token`: JSON `{clientRequestId}` returns a
  new short-lived `{uploadToken}` for a published display. This also supports
  visitor photo contributions and retries after the original capability expires.
- `GET /api/photos/:id`: approved photo bytes only when its listing is published.
  Pending/rejected/removed photos return 404 even if their ID is known.
- `GET /api/session`: `{authenticated:boolean}`.
- `POST /api/session`: `{password}`; sets a short-lived HttpOnly, Secure,
  SameSite=Strict owner session cookie. Returns `{authenticated:true}`.
- `DELETE /api/session`: logs out and revokes the session.
- `GET /api/admin/photos?status=pending|approved|rejected`: owner-only
  `{photos:[{id,status,version,position,createdAt,url,listing:Listing}]}`.
- `GET /api/admin/photos/:id/content`: owner-only private photo bytes.
- `POST /api/admin/photos/:id/decision`: owner-only JSON
  `{decision:'approved'|'rejected'|'pending',expectedVersion,reason?}`.
  Returns `{photo:{id,status,version}}`; stale decisions return 409. Photo approval
  does not change listing visibility. Moving back to pending removes public access.
- `GET /api/admin/listings?season=ID`: owner-only `{listings:Listing[]}` including
  unpublished records, with review state.
- `POST /api/admin/listings/:id/visibility`: owner-only JSON
  `{status:'published'|'hidden',expectedVersion,reason?}`; returns `{listing}`.
- `GET /api/admin/reports?status=open|dismissed&before=ID`: owner-only inbox,
  `{reports:Report[],nextCursor:ID|null}`. At most 100 messages per page, newest
  first; use `nextCursor` as `before` to continue. Report fields are
  `id,kind,listingId,seasonId,reason,message,email,status,version,createdAt,dismissedAt`
  and optional `listing:{address,title,neighborhoodId,status}`. `kind` is `report`
  or `feedback`; feedback has no listing target. Owner rendering uses `textContent`
  for visitor text, including email and listing context.
- `POST /api/admin/reports/:id/decision`: owner-only
  `{status:'dismissed'|'open',expectedVersion}` returns `{report}`. Each state
  change increments the version and writes a private audit event. A stale version
  or repeated same-state decision returns 409. Dismiss/reopen never changes listing
  publication or photo review status.

Mutating browser calls require a matching Origin and same-origin JSON/binary
requests. Never store owner credentials or upload capabilities in localStorage.
No CORS API or resident account/self-service is introduced.

New listing attempts are bounded to 30/hour per visitor IP. Photo grants are
bounded to 30/hour per visitor and per display, and upload attempts to 90/hour
per visitor. Counters store a secret-salted hash rather than the raw IP and expire
from active counter storage. Visitor photo grants authorize a pending contribution,
not ownership or listing edits. A same-state owner decision with the current
version is a no-op for listings/photos; stale versions return 409 and status changes create audit events.
New reports and feedback share a limit of 12/hour per visitor IP; a display also
accepts at most 50 new reports/hour across visitors. Identical message retries
return their original receipt before counting toward these limits. There are no
public message reads. The inbox uses the existing owner session and origin checks.

Migration `0003_community_inbox.sql` preserves legacy reports, allows feedback
without a listing, and adds immutable request identities and review audit events.
It changes the private data trust boundary and requires manual owner review and
merge under `AGENTS.md`; apply it through the normal tracked D1 migration flow.

Submission success is independent of photo upload success: keep the saved listing
and display a retryable photo error if any image fails. The receipt distinguishes
“Your display is on the map” from “Your photo is waiting for review.”
