/**
 * Beat the Brewer - Scheduled Announcer Generator
 *
 * Invoked by EventBridge (every ~2 minutes). NOT a public endpoint.
 *
 * For every event whose status is "open", this:
 *   1. Aggregates ratings (all math in Node).
 *   2. If there are new ratings since last run AND the cooldown has elapsed,
 *      asks Bedrock (Claude) to narrate the standings in the event's persona,
 *      generates ElevenLabs TTS audio, and caches the result in the
 *      announcements table for the read-only GET endpoint to serve.
 *
 * This keeps all paid generation OFF the public request path.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const TABLE_NAME = process.env.TABLE_NAME;
const BEERS_TABLE_NAME = process.env.BEERS_TABLE_NAME;
const EVENTS_TABLE_NAME = process.env.EVENTS_TABLE_NAME;
const ANNOUNCEMENTS_TABLE_NAME = process.env.ANNOUNCEMENTS_TABLE_NAME;
const ANNOUNCEMENTS_BUCKET = process.env.ANNOUNCEMENTS_BUCKET_NAME;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const DEFAULT_VOICE_ID = 'yKGyS0hnJchyz15wFwrA';
const BEDROCK_MODEL_ID = 'arn:aws:bedrock:us-east-1:918221680168:inference-profile/global.anthropic.claude-opus-4-5-20251101-v1:0';
const MIN_ANNOUNCEMENT_INTERVAL_MS = 2 * 60 * 1000;

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

// ===========================================
// Data access
// ===========================================

async function listOpenEvents() {
    const result = await docClient.send(new ScanCommand({
        TableName: EVENTS_TABLE_NAME,
        FilterExpression: '#s = :open',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':open': 'open' },
    }));
    return result.Items || [];
}

async function loadAnnouncerState(eventId) {
    const result = await docClient.send(new GetCommand({
        TableName: ANNOUNCEMENTS_TABLE_NAME,
        Key: { eventId },
    }));
    return result.Item || null;
}

async function queryRatings(eventId) {
    const ratings = [];
    let lastEvaluatedKey = null;
    do {
        const params = {
            TableName: TABLE_NAME,
            KeyConditionExpression: 'eventId = :eventId',
            ExpressionAttributeValues: { ':eventId': eventId },
        };
        if (lastEvaluatedKey) params.ExclusiveStartKey = lastEvaluatedKey;
        const result = await docClient.send(new QueryCommand(params));
        ratings.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return ratings;
}

async function queryBeersMap(eventId) {
    const beersMap = {};
    let lastEvaluatedKey = null;
    do {
        const params = {
            TableName: BEERS_TABLE_NAME,
            KeyConditionExpression: 'eventId = :eventId',
            ExpressionAttributeValues: { ':eventId': eventId },
        };
        if (lastEvaluatedKey) params.ExclusiveStartKey = lastEvaluatedKey;
        const result = await docClient.send(new QueryCommand(params));
        for (const beer of (result.Items || [])) {
            beersMap[beer.beerId] = {
                name: beer.name || beer.beerName || beer.beerId,
                brewer: beer.brewer || null,
                ingredients: beer.ingredients || null,
                style: beer.style || null,
                abv: beer.abv ?? null,
                active: beer.active !== false,
            };
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return beersMap;
}

// ===========================================
// Aggregation (all math here, not in the model)
// ===========================================

function aggregateRatings(ratings, beersMap) {
    const byBeer = {};
    let latestCreatedAt = null;

    for (const rating of ratings) {
        const { beerId, rating: score, createdAt, timestamp } = rating;
        const ratingTime = createdAt || timestamp;
        if (ratingTime && (!latestCreatedAt || ratingTime > latestCreatedAt)) {
            latestCreatedAt = ratingTime;
        }
        if (!beersMap[beerId]) continue;
        if (!byBeer[beerId]) {
            byBeer[beerId] = {
                beerId,
                beerName: beersMap[beerId].name,
                brewer: beersMap[beerId].brewer,
                ingredients: beersMap[beerId].ingredients,
                beerAbv: beersMap[beerId].abv,
                ratings: [],
            };
        }
        byBeer[beerId].ratings.push(score);
    }

    const beers = Object.values(byBeer)
        .map(beer => {
            const sum = beer.ratings.reduce((a, b) => a + b, 0);
            const avg = beer.ratings.length > 0 ? sum / beer.ratings.length : 0;
            return {
                beerId: beer.beerId,
                beerName: beer.beerName,
                brewer: beer.brewer,
                ingredients: beer.ingredients,
                beerAbv: beer.beerAbv,
                ratingCount: beer.ratings.length,
                averageRating: Math.round(avg * 10) / 10,
            };
        })
        .sort((a, b) => b.averageRating - a.averageRating || b.ratingCount - a.ratingCount);

    return { totalRatings: ratings.length, latestCreatedAt, beers };
}

// ===========================================
// Generation
// ===========================================

function buildSystemPrompt(persona) {
    const name = persona?.name || 'Sam Calagione';
    const flavor = persona?.flavorNote ? `\nEVENT FLAVOR: ${persona.flavorNote}\n` : '';
    return `You are ${name}, the legendary founder of Dogfish Head Brewery, doing live color commentary for a homebrew competition called "Beat the Brewer"!
${flavor}
CRITICAL - THIS IS FOR TEXT-TO-SPEECH:
- Write ONLY spoken words that will be read aloud by a TTS system
- NO markdown formatting (no #, *, >, ---, etc.)
- NO stage directions (no [pause], [crowd cheers], etc.)
- NO emojis or special symbols
- Write as natural spoken sentences
- Use ellipses (...) sparingly for dramatic pauses

Your personality:
- HIGH ENERGY and enthusiastic
- Use craft beer slang naturally: "crushable," "off-centered," "hop-forward"
- Playful smack talk for trailing beers (keep it fun!)
- Get EXCITED about tight races
- When ingredients are provided, riff on them naturally
- You're calling a GAME, not reading a spreadsheet

Rules:
- Keep it PG-13
- 2-4 sentences ONLY (brief update, not a monologue)
- NEVER calculate numbers - they're already correct in the data
- End with something that builds anticipation`;
}

async function generateAnnouncementText(summary, persona) {
    const userPrompt = `Current standings at Beat the Brewer:

${JSON.stringify(summary, null, 2)}

Give me a quick 2-4 sentence update. Be energetic! Call out the leader, tease any trailing beers, build excitement. If beers list standout ingredients, work them in. Pure spoken words only.`;

    try {
        const response = await bedrockClient.send(new InvokeModelCommand({
            modelId: BEDROCK_MODEL_ID,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 512,
                system: buildSystemPrompt(persona),
                messages: [{ role: 'user', content: userPrompt }],
            }),
        }));
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        return (responseBody.content?.[0]?.text || '').trim();
    } catch (error) {
        console.error('Bedrock call failed:', error);
        return generateFallbackText(summary);
    }
}

function generateFallbackText(summary) {
    if (summary.beers.length === 0) {
        return `We've got ${summary.totalRatings} ratings in, but waiting on more data to call the race. Keep those votes coming!`;
    }
    const leader = summary.beers[0];
    if (summary.beers.length === 1) {
        return `${leader.beerName} is flying solo with a ${leader.averageRating} average from ${leader.ratingCount} ratings. Let's get more beers in the mix!`;
    }
    const second = summary.beers[1];
    const gap = (leader.averageRating - second.averageRating).toFixed(1);
    if (parseFloat(gap) < 0.5) {
        return `It's a tight race! ${leader.beerName} edges out ${second.beerName} by just ${gap} points. ${summary.totalRatings} total ratings and counting!`;
    }
    return `${leader.beerName} is leading the pack with a solid ${leader.averageRating} average! ${summary.totalRatings} ratings in so far. Cheers!`;
}

async function generateTtsAudio(text, eventId, voiceId) {
    if (!ELEVENLABS_API_KEY) {
        console.log('ElevenLabs API key not configured, skipping TTS');
        return null;
    }
    try {
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId || DEFAULT_VOICE_ID}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': ELEVENLABS_API_KEY,
            },
            body: JSON.stringify({
                text,
                model_id: 'eleven_monolingual_v1',
                voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
            }),
        });
        if (!response.ok) {
            console.error('ElevenLabs API error:', response.status, await response.text());
            return null;
        }
        const audioData = Buffer.from(await response.arrayBuffer());
        const audioKey = `announcements/${eventId}/live-${Date.now()}.mp3`;
        await s3Client.send(new PutObjectCommand({
            Bucket: ANNOUNCEMENTS_BUCKET,
            Key: audioKey,
            Body: audioData,
            ContentType: 'audio/mpeg',
        }));
        return `https://${ANNOUNCEMENTS_BUCKET}.s3.amazonaws.com/${audioKey}`;
    } catch (error) {
        console.error('ElevenLabs TTS error:', error);
        return null;
    }
}

/**
 * Save announcer state WITHOUT clobbering finals / acceptingRatings.
 * Merges over the existing record.
 */
async function saveAnnouncerState(eventId, existing, fields) {
    const item = {
        ...(existing || {}),
        eventId,
        ...fields,
        updatedAt: new Date().toISOString(),
    };
    await docClient.send(new PutCommand({ TableName: ANNOUNCEMENTS_TABLE_NAME, Item: item }));
}

// ===========================================
// Per-event processing
// ===========================================

async function processEvent(eventRecord) {
    const eventId = eventRecord.eventId;
    const persona = eventRecord.persona || {};

    const state = await loadAnnouncerState(eventId);

    // Don't generate for events that have been concluded.
    if (state && state.acceptingRatings === false) {
        console.log(`[${eventId}] event closed, skipping`);
        return;
    }

    const lastRatingCount = state?.lastRatingCount || 0;
    const lastProcessedTimestamp = state?.lastProcessedTimestamp || null;
    const lastAnnouncementAt = state?.lastAnnouncementAt || null;

    const ratings = await queryRatings(eventId);
    const beersMap = await queryBeersMap(eventId);
    const aggregation = aggregateRatings(ratings, beersMap);

    const hasNewRatings =
        ratings.length > lastRatingCount ||
        (aggregation.latestCreatedAt && aggregation.latestCreatedAt > lastProcessedTimestamp);

    if (!hasNewRatings) {
        console.log(`[${eventId}] no new ratings, skipping`);
        return;
    }

    const timeSinceLast = lastAnnouncementAt ? Date.now() - new Date(lastAnnouncementAt).getTime() : Infinity;
    if (timeSinceLast < MIN_ANNOUNCEMENT_INTERVAL_MS) {
        console.log(`[${eventId}] within cooldown, skipping`);
        return;
    }

    const summary = { eventId, totalRatings: aggregation.totalRatings, beers: aggregation.beers };
    const text = await generateAnnouncementText(summary, persona);
    const audioUrl = await generateTtsAudio(text, eventId, persona.voiceId);
    const announcementAt = new Date().toISOString();

    await saveAnnouncerState(eventId, state, {
        acceptingRatings: true,
        lastProcessedTimestamp: aggregation.latestCreatedAt || announcementAt,
        lastRatingCount: ratings.length,
        lastAnnouncementText: text,
        lastAnnouncementAt: announcementAt,
        lastAudioUrl: audioUrl,
        lastLeader: aggregation.beers[0] || null,
        lastTotalRatings: aggregation.totalRatings,
    });

    console.log(`[${eventId}] generated announcement (audio: ${!!audioUrl})`);
}

// ===========================================
// Handler (EventBridge scheduled)
// ===========================================

exports.handler = async () => {
    if (!EVENTS_TABLE_NAME || !TABLE_NAME || !BEERS_TABLE_NAME || !ANNOUNCEMENTS_TABLE_NAME) {
        console.error('Missing required environment variables');
        return { processed: 0 };
    }

    const openEvents = await listOpenEvents();
    console.log(`Scheduled announcer: ${openEvents.length} open event(s)`);

    for (const ev of openEvents) {
        try {
            await processEvent(ev);
        } catch (error) {
            console.error(`Error processing event ${ev.eventId}:`, error);
        }
    }

    return { processed: openEvents.length };
};
