# Beat the Brewer 🍺

A minimal ratings site for a one-night homebrew event. Attendees scan a QR code to rate beers, and results are displayed on a live dashboard.

## Project Structure

```
beat_the_brewer_website/
├── frontend/                    # S3-hosted static site
│   ├── index.html              # Rating form page (QR code landing)
│   ├── results.html            # Live results dashboard
│   ├── js/
│   │   └── api.js              # Client-side API calls
│   └── css/
│       └── styles.css          # Mobile-friendly styling
│
├── backend/                     # AWS Lambda functions
│   ├── submitRating.js         # POST /submit-rating handler
│   ├── getRatingsSummary.js    # GET /ratings-summary handler
│   ├── template.yaml           # SAM/CloudFormation template
│   └── package.json            # Node.js dependencies
│
└── README.md
```

## Setup & Deployment

### Prerequisites

- AWS CLI configured with appropriate credentials
- AWS SAM CLI installed
- Node.js 18.x or later

### Backend Deployment

1. Navigate to the backend folder:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build and deploy with SAM:
   ```bash
   sam build
   sam deploy --guided
   ```

4. Note the API Gateway endpoint URL from the outputs.

### Frontend Deployment

1. Update `frontend/js/api.js` with your API Gateway endpoint URL.

2. Upload frontend files to an S3 bucket configured for static website hosting:
   ```bash
   aws s3 sync frontend/ s3://your-bucket-name/ --acl public-read
   ```

3. Generate QR codes pointing to:
   - Rating form: `https://your-bucket.s3.amazonaws.com/index.html?eventId=your-event-id`
   - Results: `https://your-bucket.s3.amazonaws.com/results.html?eventId=your-event-id`

## Usage

1. **Before the event**: Deploy backend and frontend, generate QR codes
2. **During the event**: Attendees scan QR code and submit ratings
3. **View results**: Open results.html on a screen for live leaderboard

## API Endpoints

### POST /submit-rating

Submit a beer rating.

**Request body:**
```json
{
  "eventId": "event-2024",
  "beerId": "beer1",
  "rating": 4,
  "comments": "Great hop profile!"
}
```

### GET /ratings-summary?eventId={eventId}

Get aggregated ratings for an event.

**Response:**
```json
{
  "eventId": "event-2024",
  "totalRatings": 45,
  "beers": [
    {
      "beerId": "beer1",
      "name": "Beer #1",
      "avgRating": 4.2,
      "totalRatings": 15
    }
  ]
}
```

## TODO

- [ ] Add beer configuration (names, descriptions)
- [ ] Implement star rating UI component
- [ ] Add user session tracking to prevent duplicate votes
- [ ] Set up CloudFront distribution for frontend
- [ ] Add authentication for results page (optional)
- [ ] Implement auto-refresh on results page
