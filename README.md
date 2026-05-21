# Beat the Brewer 🍺

A multi-event homebrew rating site. Attendees scan a QR code to rate beers (1–10
with comments); a live results dashboard and a TV "announcer" display show
standings, and an AI announcer (Claude on Bedrock + ElevenLabs TTS) calls the
action in the voice of a configurable persona.

Built for the **Grist Homebrew Club**. Designed to be reset and re-run for each
competition — no code edits required between events.

## Architecture

```
Browser (phones + TV)
   │
   ├─ Static site (S3 bucket, served over HTTPS via CloudFront)
   │    index.html      – voting form (QR landing)
   │    results.html    – live results dashboard
   │    announcer.html  – full-screen TV display
   │    admin.html      – competitions + beers + conclude/reset
   │    js/api.js, css/styles.css
   │
   └─► Lambda Function URLs (no API Gateway)
         submitRating · getRatingsSummary · getBeers · upsertBeer · deleteBeer ·
         eventsApi · getLiveAnnouncement (read-only) · generateFinalAnnouncement · resetRatings
              │
              ├─ DynamoDB: Events, Beers, Ratings, Announcements
              ├─ S3: generated TTS audio (public-read)
              ├─ Bedrock: Claude (announcer commentary)
              └─ ElevenLabs API: text-to-speech
   │
   └─ EventBridge (rate: 2 min) ──► ScheduledAnnouncer Lambda
        Generates live commentary + audio for OPEN events and caches it,
        so the public read path costs nothing and the TV can poll freely.
```

### Data model

- **Events** (`eventId` PK): per-competition config — `displayName`, `clubName`,
  `subtitle`, `status` (`setup`/`open`/`closed`), `isActive`, and a `persona`
  (`name`, `voiceId`, `flavorNote`).
- **Beers** (`eventId` + `beerId`): `name`, `brewer`, `ingredients`, `style`,
  `abv`, `active`.
- **Ratings** (`eventId` + `ratingId`): `beerId`, `rating`, `comment`,
  `voterToken`, `createdAt`. With a `voterToken`, `ratingId` is
  `beerId#voterToken` and writes are conditional → one vote per beer per device,
  enforced server-side.
- **Announcements** (`eventId` PK): cached announcer state + final announcement.

## Setup & Deployment

### Prerequisites
- AWS CLI configured
- AWS SAM CLI
- Node.js 18+
- An ElevenLabs API key (optional — without it, announcements are text-only)
- Bedrock model access enabled for Claude in your region

### Backend
```bash
cd backend && npm install && cd ..
sam build
sam deploy --guided    # first time; supply ElevenLabsApiKey
# subsequent deploys:
sam deploy
```
Function URLs persist across deploys. Note the stack outputs — especially
**`EventsApiUrl`** (new) and **`SiteBucketName`** / **`SiteURL`**.

### Frontend
1. Paste the `EventsApiUrl` output into `EVENTS_API_URL` in
   [`frontend/js/api.js`](frontend/js/api.js). (The other Function URLs are
   already filled in and only change on a brand-new stack.)
2. Sync to the site bucket and invalidate CloudFront:
   ```bash
   aws s3 sync frontend/ s3://<SiteBucketName>/
   aws cloudfront create-invalidation --distribution-id <SiteDistributionId> --paths "/*"
   ```
3. Open the `SiteURL` (CloudFront HTTPS URL).

## Running a competition

Everything below is done in **admin.html** — no code changes.

1. **Create the competition.** In *Competitions*, add an event (id, display name,
   club line, optional tagline, announcer persona + flavor note). Save.
2. **Set it active.** Click *Set Active* so voters who open the bare site land on
   it. (Or hand out a QR to `index.html?eventId=<id>` to target it explicitly.)
3. **Add beers** with brewer + H Mart ingredient(s). Set status to **Open**.
4. **Share the QR codes:**
   - Vote: `<SiteURL>/index.html?eventId=<id>`
   - Results: `<SiteURL>/results.html?eventId=<id>`
   - TV display: `<SiteURL>/announcer.html?eventId=<id>`
5. **During:** the TV display polls standings every 5s; the AI announcer is
   generated server-side every ~2 min for open events and played on the TV.
6. **Conclude:** *Conclude Event* closes voting and generates the final
   announcement + audio.

### Resetting
- **Reset Ratings** (admin) clears ratings for the current event but keeps the
  beers — ideal for dry runs.
- **New competition** = create a new event; past events stay intact and can be
  reopened/viewed via `?eventId=`.

### Seeding test data (optional)
```bash
cd backend && npm install && cd ..
node scripts/seedCompetition.js scripts/hmart-june2026.json
```
Seeds an event, its beers, and sample ratings. Copy the JSON to spin up your own.

## Cost notes
- DynamoDB is on-demand; Lambdas are tiny. At rest this costs ~nothing.
- The only metered work is the announcer: Bedrock + ElevenLabs run on the 2-min
  EventBridge schedule **only while an event's status is `open`**. Set events to
  `closed` (or conclude them) when you're done to stop generation.
