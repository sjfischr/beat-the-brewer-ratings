/**
 * Seed a competition (event + beers + optional sample ratings) into DynamoDB.
 *
 * Usage:
 *   node scripts/seedCompetition.js [path/to/config.json]
 *
 * Defaults to scripts/hmart-june2026.json.
 *
 * Config shape:
 * {
 *   "event":   { eventId, displayName, clubName, subtitle, status, isActive, persona:{name,voiceId,flavorNote} },
 *   "beers":   [ { beerId, name, brewer, ingredients, style, abv, active } ],
 *   "ratings": [ { beerId, rating, comment } ]   // optional - for demos/testing
 * }
 *
 * Table names are read from env (falling back to the template defaults):
 *   EVENTS_TABLE_NAME, BEERS_TABLE_NAME, TABLE_NAME, AWS_REGION
 *
 * Prerequisites: AWS credentials configured; `npm install` run in backend/.
 */

const { DynamoDBClient } = require('../backend/node_modules/@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('../backend/node_modules/@aws-sdk/lib-dynamodb');
const fs = require('fs');
const path = require('path');

const REGION = process.env.AWS_REGION || 'us-east-1';
const EVENTS_TABLE = process.env.EVENTS_TABLE_NAME || 'BeatTheBrewerEvents';
const BEERS_TABLE = process.env.BEERS_TABLE_NAME || 'BeatTheBrewerBeers';
const RATINGS_TABLE = process.env.TABLE_NAME || 'BeatTheBrewerRatings';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function recentTimestamp() {
    const now = Date.now();
    const start = now - 60 * 60 * 1000; // within the last hour
    return new Date(start + Math.random() * (now - start)).toISOString();
}

async function main() {
    const configPath = process.argv[2]
        ? path.resolve(process.argv[2])
        : path.join(__dirname, 'hmart-june2026.json');

    if (!fs.existsSync(configPath)) {
        console.error(`Config not found: ${configPath}`);
        process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { event, beers = [], ratings = [] } = config;

    if (!event || !event.eventId) {
        console.error('Config must include an "event" with an "eventId".');
        process.exit(1);
    }
    const eventId = event.eventId;
    console.log(`Seeding competition "${eventId}" from ${path.basename(configPath)}`);
    console.log('-'.repeat(50));

    // 1. Event
    const now = new Date().toISOString();
    await docClient.send(new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
            eventId,
            displayName: event.displayName || eventId,
            clubName: event.clubName || '',
            subtitle: event.subtitle || '',
            status: event.status || 'setup',
            isActive: event.isActive !== false,
            persona: {
                name: event.persona?.name || 'Sam Calagione',
                voiceId: event.persona?.voiceId || 'yKGyS0hnJchyz15wFwrA',
                flavorNote: event.persona?.flavorNote || '',
            },
            createdAt: now,
            updatedAt: now,
        },
    }));
    console.log(`Event saved: ${event.displayName || eventId}`);

    // 2. Beers
    for (const beer of beers) {
        const item = {
            eventId,
            beerId: beer.beerId,
            name: beer.name,
            active: beer.active !== false,
            updatedAt: now,
        };
        if (beer.brewer) item.brewer = beer.brewer;
        if (beer.ingredients) item.ingredients = beer.ingredients;
        if (beer.style) item.style = beer.style;
        if (beer.abv != null) item.abv = Number(beer.abv);
        await docClient.send(new PutCommand({ TableName: BEERS_TABLE, Item: item }));
    }
    console.log(`Beers saved: ${beers.length}`);

    // 3. Sample ratings (optional)
    let ok = 0;
    for (const r of ratings) {
        await docClient.send(new PutCommand({
            TableName: RATINGS_TABLE,
            Item: {
                eventId,
                ratingId: uuid(),
                beerId: r.beerId,
                rating: r.rating,
                comment: r.comment || '',
                createdAt: recentTimestamp(),
            },
        }));
        ok++;
        if (ok % 10 === 0) process.stdout.write(`\r  ratings: ${ok}/${ratings.length}`);
    }
    if (ratings.length) console.log(`\rSample ratings saved: ${ok}/${ratings.length}     `);

    console.log('-'.repeat(50));
    console.log('Done. Open the site with ?eventId=' + eventId + ' (or set it active in the admin).');
}

main().catch((err) => { console.error(err); process.exit(1); });
