/**
 * Beat the Brewer - Get Live Announcement Lambda Handler
 * 
 * GET /live-announcement?eventId=xxx
 * 
 * Generates periodic humorous announcements for a live "announcer" page.
 * Only produces new commentary when there are new ratings since last announcement.
 * 
 * All aggregation and math is done in Node.js — Bedrock (Claude) is ONLY used
 * to generate the Sam-Calagione-style bro-y commentary from the pre-computed summary.
 * 
 * ElevenLabs Voice ID: yKGyS0hnJchyz15wFwrA
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

// ===========================================
// Configuration
// ===========================================

const TABLE_NAME = process.env.TABLE_NAME;
const BEERS_TABLE_NAME = process.env.BEERS_TABLE_NAME;
const ANNOUNCEMENTS_TABLE_NAME = process.env.ANNOUNCEMENTS_TABLE_NAME;
const ANNOUNCEMENTS_BUCKET = process.env.ANNOUNCEMENTS_BUCKET_NAME;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// ElevenLabs Configuration
const ELEVENLABS_VOICE_ID = 'yKGyS0hnJchyz15wFwrA';
const ELEVENLABS_API_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

// Bedrock Model Configuration - Using Claude Opus 4.5 via inference profile
const BEDROCK_MODEL_ID = 'arn:aws:bedrock:us-east-1:918221680168:inference-profile/global.anthropic.claude-opus-4-5-20251101-v1:0';

// Initialize clients
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

// Response headers (CORS handled by Function URL config, but include Content-Type)
const RESPONSE_HEADERS = {
    'Content-Type': 'application/json',
};

// ===========================================
// Helper Functions
// ===========================================

/**
 * Build a Lambda response object.
 */
function buildResponse(statusCode, body) {
    return {
        statusCode,
        headers: RESPONSE_HEADERS,
        body: JSON.stringify(body),
    };
}

/**
 * Load the current announcer state from the announcements table.
 * @param {string} eventId 
 * @returns {object|null} - The announcement record or null if not found
 */
async function loadAnnouncerState(eventId) {
    try {
        const result = await docClient.send(new GetCommand({
            TableName: ANNOUNCEMENTS_TABLE_NAME,
            Key: { eventId },
        }));
        return result.Item || null;
    } catch (error) {
        console.error('Error loading announcer state:', error);
        return null;
    }
}

/**
 * Save the announcer state back to the announcements table.
 */
async function saveAnnouncerState(eventId, lastProcessedTimestamp, lastRatingCount, lastAnnouncementText) {
    await docClient.send(new PutCommand({
        TableName: ANNOUNCEMENTS_TABLE_NAME,
        Item: {
            eventId,
            lastProcessedTimestamp,
            lastRatingCount,
            lastAnnouncementText,
            updatedAt: new Date().toISOString(),
            // Preserve acceptingRatings if it exists (don't overwrite)
            acceptingRatings: true,
        },
    }));
}

/**
 * Query all ratings for an event.
 * @param {string} eventId 
 * @returns {Array} - Array of rating items
 */
async function queryRatings(eventId) {
    const ratings = [];
    let lastEvaluatedKey = null;

    do {
        const params = {
            TableName: TABLE_NAME,
            KeyConditionExpression: 'eventId = :eventId',
            ExpressionAttributeValues: { ':eventId': eventId },
        };
        if (lastEvaluatedKey) {
            params.ExclusiveStartKey = lastEvaluatedKey;
        }

        const result = await docClient.send(new QueryCommand(params));
        ratings.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return ratings;
}

/**
 * Query all beers for an event and build a lookup map.
 * @param {string} eventId 
 * @returns {object} - Map of beerId -> { name, abv, active }
 */
async function queryBeersMap(eventId) {
    const beersMap = {};
    let lastEvaluatedKey = null;

    do {
        const params = {
            TableName: BEERS_TABLE_NAME,
            KeyConditionExpression: 'eventId = :eventId',
            ExpressionAttributeValues: { ':eventId': eventId },
        };
        if (lastEvaluatedKey) {
            params.ExclusiveStartKey = lastEvaluatedKey;
        }

        const result = await docClient.send(new QueryCommand(params));
        for (const beer of (result.Items || [])) {
            beersMap[beer.beerId] = {
                name: beer.name || beer.beerName || beer.beerId,
                abv: beer.abv || null,
                active: beer.active !== false, // default true
            };
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return beersMap;
}

/**
 * Aggregate ratings by beer.
 * All math is done here in Node.js — the model only narrates the results.
 * 
 * @param {Array} ratings - All rating items
 * @param {object} beersMap - Map of beerId -> beer metadata
 * @returns {object} - { totalRatings, latestCreatedAt, beers: [...] }
 */
function aggregateRatings(ratings, beersMap) {
    const byBeer = {};
    let latestCreatedAt = null;

    for (const rating of ratings) {
        const { beerId, rating: score, createdAt, timestamp } = rating;
        const ratingTime = createdAt || timestamp; // Support both field names

        // Track latest timestamp
        if (ratingTime && (!latestCreatedAt || ratingTime > latestCreatedAt)) {
            latestCreatedAt = ratingTime;
        }

        // Skip beers that don't exist in beersMap (deleted beers)
        if (!beersMap[beerId]) {
            continue;
        }

        // Aggregate by beer
        if (!byBeer[beerId]) {
            byBeer[beerId] = {
                beerId,
                beerName: beersMap[beerId]?.name || beerId,
                beerAbv: beersMap[beerId]?.abv || null,
                ratings: [],
            };
        }
        byBeer[beerId].ratings.push(score);
    }

    // Compute averages and sort by average rating descending
    const beers = Object.values(byBeer)
        .map(beer => {
            const sum = beer.ratings.reduce((a, b) => a + b, 0);
            const avg = beer.ratings.length > 0 ? sum / beer.ratings.length : 0;
            return {
                beerId: beer.beerId,
                beerName: beer.beerName,
                beerAbv: beer.beerAbv,
                ratingCount: beer.ratings.length,
                averageRating: Math.round(avg * 10) / 10, // Round to 1 decimal
            };
        })
        .sort((a, b) => b.averageRating - a.averageRating || b.ratingCount - a.ratingCount);

    return {
        totalRatings: ratings.length,
        latestCreatedAt,
        beers,
    };
}

/**
 * Generate humorous, bro-y Sam-Calagione-style commentary using Bedrock Claude.
 * 
 * IMPORTANT: All math and aggregation is already done in Node.js.
 * The model is ONLY used to narrate/read the pre-computed summary in a fun voice.
 * It does NOT calculate averages, counts, or rankings — those are provided.
 * 
 * @param {object} summary - Pre-aggregated summary with totalRatings, beers array, etc.
 * @returns {string} - The generated announcement text
 */
async function generateAnnouncementText(summary) {
    const systemPrompt = `You are Sam Calagione, the legendary founder of Dogfish Head Brewery, doing live color commentary for a homebrew competition called "Beat the Brewer" hosted by the Grist Homebrew Club!

Your personality:
- HIGH ENERGY and enthusiastic — you LOVE watching people vote on homebrew
- Introduce yourself occasionally: "Hey, it's Sam Calagione from Dogfish Head!"
- Give a shout-out to the Grist Homebrew Club for hosting another fantastic event
- Use craft beer slang naturally: "crushable," "mouthfeel," "off-centered," "hop-forward," "sessionable"
- Throw in playful smack talk and banter — tease the beers that are trailing (in a fun way!)
- When races are tight, get EXCITED about the drama
- Reference specific aspects like ABV when relevant
- You're not just reading numbers — you're calling a GAME
- Think of yourself as the John Madden of craft beer

Rules:
- Keep it PG-13, no cursing
- 3-5 sentences for this update
- Be encouraging but also have FUN with the competition
- Light trash talk is OK: "Oooh, Beer X better step it up!" or "Someone wake up that IPA!"
- Celebrate the leaders but don't forget the underdogs
- NEVER calculate numbers — they're already correct in the data
- End with something that builds anticipation for more votes`;

    const userPrompt = `Here's the current state of the Beat the Brewer competition at the Grist Homebrew Club. Give me a fun, energetic play-by-play update!

${JSON.stringify(summary, null, 2)}

Give me 3-5 sentences. Be animated! Call out tight races, tease the trailing beers, hype up the leaders. Channel your inner sports announcer mixed with craft beer passion!`;

    try {
        const response = await bedrockClient.send(new InvokeModelCommand({
            modelId: BEDROCK_MODEL_ID,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 512,
                system: systemPrompt,
                messages: [
                    { role: 'user', content: userPrompt }
                ],
            }),
        }));

        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const text = responseBody.content?.[0]?.text || '';
        return text.trim();
    } catch (error) {
        console.error('Bedrock call failed:', error);
        // Fallback to a simple generated message if Bedrock fails
        return generateFallbackText(summary);
    }
}

/**
 * Generate a simple fallback announcement if Bedrock is unavailable.
 */
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

/**
 * Generate TTS audio using ElevenLabs API and store in S3.
 * 
 * @param {string} text - The text to convert to speech
 * @param {string} eventId - The event identifier
 * @returns {object} - { audioUrl, success }
 */
async function generateTtsAudio(text, eventId) {
    if (!ELEVENLABS_API_KEY) {
        console.log('ElevenLabs API key not configured, skipping TTS');
        return { audioUrl: null, success: false };
    }

    try {
        // Call ElevenLabs API
        const response = await fetch(ELEVENLABS_API_URL, {
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': ELEVENLABS_API_KEY,
            },
            body: JSON.stringify({
                text: text,
                model_id: 'eleven_monolingual_v1',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.5,
                    use_speaker_boost: true,
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('ElevenLabs API error:', response.status, errorText);
            return { audioUrl: null, success: false };
        }

        // Get audio data as buffer
        const audioBuffer = await response.arrayBuffer();
        const audioData = Buffer.from(audioBuffer);

        // Generate unique filename with timestamp
        const timestamp = Date.now();
        const audioKey = `announcements/${eventId}/live-${timestamp}.mp3`;

        // Upload to S3
        await s3Client.send(new PutObjectCommand({
            Bucket: ANNOUNCEMENTS_BUCKET,
            Key: audioKey,
            Body: audioData,
            ContentType: 'audio/mpeg',
        }));

        const audioUrl = `https://${ANNOUNCEMENTS_BUCKET}.s3.amazonaws.com/${audioKey}`;
        console.log('Generated TTS audio:', audioUrl);

        return { audioUrl, success: true };
    } catch (error) {
        console.error('ElevenLabs TTS error:', error);
        return { audioUrl: null, success: false };
    }
}

// ===========================================
// Lambda Handler
// ===========================================

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    try {
        // Validate environment
        if (!TABLE_NAME || !BEERS_TABLE_NAME || !ANNOUNCEMENTS_TABLE_NAME) {
            console.error('Missing required environment variables');
            return buildResponse(500, { hasUpdate: false, error: 'Server configuration error' });
        }

        // Extract eventId from query string
        const eventId = event.queryStringParameters?.eventId;
        if (!eventId) {
            return buildResponse(400, { hasUpdate: false, error: 'eventId query parameter is required' });
        }

        // Step 1: Load current announcer state
        const announcerState = await loadAnnouncerState(eventId);
        const lastProcessedTimestamp = announcerState?.lastProcessedTimestamp || null;
        const lastRatingCount = announcerState?.lastRatingCount || 0;

        console.log('Announcer state:', { lastProcessedTimestamp, lastRatingCount });

        // Step 2: Query all ratings for this event
        const ratings = await queryRatings(eventId);
        console.log(`Found ${ratings.length} total ratings for event ${eventId}`);

        // Step 3: Query beers for metadata
        const beersMap = await queryBeersMap(eventId);
        console.log(`Found ${Object.keys(beersMap).length} beers for event ${eventId}`);

        // Step 4: Aggregate ratings (all math done in Node.js)
        const aggregation = aggregateRatings(ratings, beersMap);
        console.log('Aggregation:', JSON.stringify(aggregation, null, 2));

        // Step 5: Check if there are new ratings since last announcement
        const currentRatingCount = ratings.length;
        const hasNewRatings = currentRatingCount > lastRatingCount || 
            (aggregation.latestCreatedAt && aggregation.latestCreatedAt > lastProcessedTimestamp);

        if (!hasNewRatings) {
            console.log('No new ratings since last announcement');
            return buildResponse(200, { hasUpdate: false });
        }

        // Step 6: Prepare summary for the model (pre-aggregated data only)
        const summary = {
            eventId,
            totalRatings: aggregation.totalRatings,
            beers: aggregation.beers,
        };

        // Step 7: Generate announcement text using Bedrock Claude
        // NOTE: Model only narrates — all math was done above in aggregateRatings()
        const announcementText = await generateAnnouncementText(summary);
        console.log('Generated announcement:', announcementText);

        // Step 8: Generate TTS audio using ElevenLabs
        const { audioUrl } = await generateTtsAudio(announcementText, eventId);
        console.log('TTS audio URL:', audioUrl);

        // Step 9: Save updated announcer state
        await saveAnnouncerState(
            eventId,
            aggregation.latestCreatedAt || new Date().toISOString(),
            currentRatingCount,
            announcementText
        );

        // Step 10: Return success response
        return buildResponse(200, {
            hasUpdate: true,
            text: announcementText,
            audioUrl: audioUrl, // ElevenLabs audio URL
            // Include summary for debugging/display (optional)
            summary: {
                totalRatings: summary.totalRatings,
                leader: summary.beers[0] || null,
            },
        });

    } catch (error) {
        console.error('Unexpected error:', error);
        return buildResponse(500, { hasUpdate: false, error: 'Internal server error' });
    }
};
