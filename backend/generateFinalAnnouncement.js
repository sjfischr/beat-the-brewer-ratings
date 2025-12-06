/**
 * Beat the Brewer - Generate Final Announcement Lambda Handler
 * 
 * POST /final-announcement
 * 
 * When admin clicks "Conclude Event", this Lambda:
 * 1. Closes the event for new ratings (acceptingRatings = false)
 * 2. Aggregates all ratings and standings
 * 3. Calls Bedrock to generate a final, humorous, bro-y Sam-Calagione-style readout
 * 4. Generates TTS audio using ElevenLabs and stores in S3
 * 
 * All aggregation and math is done in Node.js — Bedrock (Claude) ONLY generates
 * the humorous script from the pre-computed summary.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
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

// Response headers
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
 * Mark the event as closed for new ratings.
 * @param {string} eventId 
 */
async function closeEventForRatings(eventId) {
    // First, try to get existing record to preserve other fields
    const existing = await docClient.send(new GetCommand({
        TableName: ANNOUNCEMENTS_TABLE_NAME,
        Key: { eventId },
    }));

    const item = {
        eventId,
        acceptingRatings: false,
        closedAt: new Date().toISOString(),
        ...(existing.Item || {}),
        acceptingRatings: false, // Ensure this overwrites
    };

    await docClient.send(new PutCommand({
        TableName: ANNOUNCEMENTS_TABLE_NAME,
        Item: item,
    }));

    console.log(`Event ${eventId} closed for ratings`);
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
                active: beer.active !== false,
            };
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return beersMap;
}

/**
 * Aggregate ratings by beer and prepare final standings.
 * All math is done here in Node.js — the model only narrates the results.
 * 
 * @param {Array} ratings - All rating items
 * @param {object} beersMap - Map of beerId -> beer metadata
 * @returns {Array} - Sorted array of beer standings with comments
 */
function aggregateStandings(ratings, beersMap) {
    const byBeer = {};

    for (const rating of ratings) {
        const { beerId, rating: score, comment, createdAt } = rating;

        // Skip beers that don't exist in beersMap (deleted beers)
        if (!beersMap[beerId]) {
            continue;
        }

        if (!byBeer[beerId]) {
            byBeer[beerId] = {
                beerId,
                beerName: beersMap[beerId]?.name || beerId,
                beerAbv: beersMap[beerId]?.abv || null,
                ratings: [],
                comments: [],
            };
        }

        byBeer[beerId].ratings.push(score);

        // Collect comments with metadata for selection
        if (comment && comment.trim()) {
            byBeer[beerId].comments.push({
                text: comment.trim(),
                length: comment.trim().length,
                createdAt,
            });
        }
    }

    // Compute averages, select notable comments, and sort
    const standings = Object.values(byBeer)
        .map(beer => {
            const sum = beer.ratings.reduce((a, b) => a + b, 0);
            const avg = beer.ratings.length > 0 ? sum / beer.ratings.length : 0;

            // Select 1-3 notable comments (shortest ones that are still meaningful)
            const notableComments = beer.comments
                .filter(c => c.length >= 10 && c.length <= 150) // Filter reasonable length
                .sort((a, b) => a.length - b.length) // Shortest first
                .slice(0, 3)
                .map(c => c.text);

            // If no "notable" comments, just take the most recent ones
            if (notableComments.length === 0 && beer.comments.length > 0) {
                const recent = beer.comments
                    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                    .slice(0, 2)
                    .map(c => c.text.substring(0, 100)); // Truncate long ones
                notableComments.push(...recent);
            }

            return {
                beerId: beer.beerId,
                beerName: beer.beerName,
                beerAbv: beer.beerAbv,
                ratingCount: beer.ratings.length,
                averageRating: Math.round(avg * 10) / 10,
                comments: notableComments,
            };
        })
        // Sort by averageRating desc, then by ratingCount desc as tiebreaker
        .sort((a, b) => {
            if (b.averageRating !== a.averageRating) {
                return b.averageRating - a.averageRating;
            }
            return b.ratingCount - a.ratingCount;
        });

    return standings;
}

/**
 * Generate the final humorous, bro-y Sam-Calagione-style script using Bedrock Claude.
 * 
 * IMPORTANT: All math, aggregation, and ranking is already done in Node.js.
 * The model ONLY generates the script from the pre-computed summary.
 * It does NOT calculate averages, counts, or rankings — those are provided.
 * 
 * @param {object} summary - Pre-aggregated summary with eventId and beers array
 * @returns {string} - The generated final script text
 */
async function generateFinalScript(summary) {
    const systemPrompt = `You are Sam Calagione, the legendary founder of Dogfish Head Brewery, delivering the GRAND FINALE announcement for the "Beat the Brewer" homebrew competition hosted by the Grist Homebrew Club!

CRITICAL - THIS IS FOR TEXT-TO-SPEECH:
- Write ONLY spoken words that will be read aloud by a TTS system
- NO markdown formatting (no #, *, >, ---, etc.)
- NO stage directions (no [pause], [crowd cheers], [drumroll], etc.)
- NO emojis or special symbols
- NO section headers or bullet points
- Write as one continuous spoken monologue with natural paragraph breaks
- Use ellipses (...) for dramatic pauses instead of stage directions
- Keep it CONCISE: aim for 60-90 seconds when read aloud (about 150-200 words)

Your personality:
- You are PUMPED and energetic
- Start with: "Hey everybody, it's Sam Calagione from Dogfish Head!"
- Use craft beer vocabulary naturally: "crushable," "hop-forward," "sessionable," "off-centered"
- Build suspense naturally through your word choice and pacing
- Playful trash talk is welcome but keep it friendly
- When announcing the winner, go BIG
- Quote 1-2 funny voter comments per beer (just read them naturally, no quote marks needed)

CONTENT RULES:
- All rankings and averages are PRE-CALCULATED in the JSON - just read them
- Keep it PG-13
- Announce from last place to first (builds suspense)
- Make everyone feel appreciated
- Close with a quick toast to craft beer and community`;



    const userPrompt = `FINAL RESULTS - Beat the Brewer at Grist Homebrew Club:

${JSON.stringify(summary, null, 2)}

Write a 150-200 word spoken announcement (60-90 seconds when read aloud):
1. Quick intro as Sam from Dogfish Head, congratulate Grist
2. Announce from last place to first - for each: name, brewer, rating, and one quick comment
3. Build to the winner reveal with energy
4. Brief closing toast

Remember: NO markdown, NO emojis, NO stage directions. Pure spoken words only.`;

    try {
        console.log('Calling Bedrock with model ID:', BEDROCK_MODEL_ID);
        const requestBody = {
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 1024,
            system: systemPrompt,
            messages: [
                { role: 'user', content: userPrompt }
            ],
        };
        console.log('Request payload (excluding prompts):', JSON.stringify({ anthropic_version: requestBody.anthropic_version, max_tokens: requestBody.max_tokens }));
        
        const response = await bedrockClient.send(new InvokeModelCommand({
            modelId: BEDROCK_MODEL_ID,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(requestBody),
        }));

        console.log('Bedrock response received successfully');
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const text = responseBody.content?.[0]?.text || '';
        return text.trim();
    } catch (error) {
        console.error('Bedrock call failed:', error);
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Model ID used:', BEDROCK_MODEL_ID);
        // Fallback to a simple generated script
        return generateFallbackScript(summary);
    }
}

/**
 * Generate a simple fallback script if Bedrock is unavailable.
 */
function generateFallbackScript(summary) {
    const { beers } = summary;
    
    if (!beers || beers.length === 0) {
        return "Well folks, it looks like we didn't have any beers to judge this time! Thanks for coming out, and we'll catch you at the next Beat the Brewer event. Cheers!";
    }

    let script = "Alright everybody, the votes are in and it's time to announce the winners of Beat the Brewer!\n\n";

    if (beers.length >= 3) {
        const third = beers[2];
        script += `In third place with a solid ${third.averageRating} average from ${third.ratingCount} ratings... ${third.beerName}! Great showing!\n\n`;
    }

    if (beers.length >= 2) {
        const second = beers[1];
        script += `Taking second place with ${second.averageRating} average across ${second.ratingCount} ratings... ${second.beerName}! Fantastic brew!\n\n`;
    }

    const first = beers[0];
    script += `And your WINNER, with an incredible ${first.averageRating} average from ${first.ratingCount} ratings... ${first.beerName}! Congratulations!\n\n`;

    script += "Thanks to everyone who came out, voted, and celebrated great beer with us. Until next time, keep it off-centered and keep brewing! Cheers! 🍺";

    return script;
}

/**
 * Generate TTS audio using ElevenLabs API and store in S3.
 * 
 * @param {string} finalText - The script text to convert to speech
 * @param {string} eventId - The event identifier
 * @returns {object} - { audioKey, audioUrl, ttsGenerated }
 */
async function generateTtsAudio(finalText, eventId) {
    const audioKey = `announcements/${eventId}/final.mp3`;
    
    if (!ELEVENLABS_API_KEY) {
        console.log('ElevenLabs API key not configured, storing text only');
        // Store text as fallback
        try {
            await s3Client.send(new PutObjectCommand({
                Bucket: ANNOUNCEMENTS_BUCKET,
                Key: `announcements/${eventId}/final-script.txt`,
                Body: finalText,
                ContentType: 'text/plain',
            }));
        } catch (error) {
            console.error('Failed to store script to S3:', error);
        }
        return {
            audioKey,
            audioUrl: null,
            ttsGenerated: false,
        };
    }

    try {
        console.log('Calling ElevenLabs API for TTS...');
        
        // Call ElevenLabs API
        const response = await fetch(ELEVENLABS_API_URL, {
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': ELEVENLABS_API_KEY,
            },
            body: JSON.stringify({
                text: finalText,
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
            throw new Error(`ElevenLabs API error: ${response.status}`);
        }

        // Get audio data as buffer
        const audioBuffer = await response.arrayBuffer();
        const audioData = Buffer.from(audioBuffer);

        console.log(`Generated ${audioData.length} bytes of audio`);

        // Upload to S3
        await s3Client.send(new PutObjectCommand({
            Bucket: ANNOUNCEMENTS_BUCKET,
            Key: audioKey,
            Body: audioData,
            ContentType: 'audio/mpeg',
        }));

        const audioUrl = `https://${ANNOUNCEMENTS_BUCKET}.s3.amazonaws.com/${audioKey}`;
        console.log('Stored TTS audio to S3:', audioUrl);

        // Also store the text for reference
        await s3Client.send(new PutObjectCommand({
            Bucket: ANNOUNCEMENTS_BUCKET,
            Key: `announcements/${eventId}/final-script.txt`,
            Body: finalText,
            ContentType: 'text/plain',
        }));

        return {
            audioKey,
            audioUrl,
            ttsGenerated: true,
        };
    } catch (error) {
        console.error('ElevenLabs TTS error:', error);
        return {
            audioKey,
            audioUrl: null,
            ttsGenerated: false,
        };
    }
}

/**
 * Store the final announcement data in DynamoDB.
 */
async function storeFinalAnnouncement(eventId, finalText, audioKey) {
    const existing = await docClient.send(new GetCommand({
        TableName: ANNOUNCEMENTS_TABLE_NAME,
        Key: { eventId },
    }));

    const item = {
        ...(existing.Item || {}),
        eventId,
        acceptingRatings: false,
        finalText,
        finalAudioKey: audioKey,
        finalGeneratedAt: new Date().toISOString(),
    };

    await docClient.send(new PutCommand({
        TableName: ANNOUNCEMENTS_TABLE_NAME,
        Item: item,
    }));

    console.log(`Stored final announcement for event ${eventId}`);
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
            return buildResponse(500, { message: 'Server configuration error' });
        }

        // Parse request body
        let body;
        try {
            body = JSON.parse(event.body || '{}');
        } catch (parseError) {
            console.error('Failed to parse request body:', parseError);
            return buildResponse(400, { message: 'Invalid JSON in request body' });
        }

        // Validate eventId
        const { eventId, regenerate } = body;
        if (!eventId || typeof eventId !== 'string' || eventId.trim() === '') {
            return buildResponse(400, { message: 'eventId is required in request body' });
        }

        const trimmedEventId = eventId.trim();
        console.log(`Generating final announcement for event: ${trimmedEventId}, regenerate: ${regenerate}`);

        // Check for cached announcement first (unless regenerate flag is set)
        if (!regenerate) {
            const cached = await docClient.send(new GetCommand({
                TableName: ANNOUNCEMENTS_TABLE_NAME,
                Key: { eventId: trimmedEventId },
            }));

            if (cached.Item && cached.Item.finalText && cached.Item.finalAudioKey) {
                console.log('Returning cached final announcement');
                const audioUrl = `https://${ANNOUNCEMENTS_BUCKET}.s3.amazonaws.com/${cached.Item.finalAudioKey}`;
                
                // Still need to compute standings for the response
                const ratings = await queryRatings(trimmedEventId);
                const beersMap = await queryBeersMap(trimmedEventId);
                const standings = aggregateStandings(ratings, beersMap);

                return buildResponse(200, {
                    message: 'Final announcement retrieved from cache',
                    text: cached.Item.finalText,
                    audioUrl,
                    eventClosed: true,
                    cached: true,
                    generatedAt: cached.Item.finalGeneratedAt,
                    standings: standings.slice(0, 3).map(b => ({
                        place: standings.indexOf(b) + 1,
                        beerName: b.beerName,
                        averageRating: b.averageRating,
                        ratingCount: b.ratingCount,
                    })),
                });
            }
        }

        // Step 1: Mark event as closed for new ratings
        await closeEventForRatings(trimmedEventId);
        console.log('Event closed for ratings');

        // Step 2: Query all ratings for this event
        const ratings = await queryRatings(trimmedEventId);
        console.log(`Found ${ratings.length} total ratings`);

        // Step 3: Query beers for metadata
        const beersMap = await queryBeersMap(trimmedEventId);
        console.log(`Found ${Object.keys(beersMap).length} beers`);

        // Step 4: Aggregate standings (all math done in Node.js)
        const standings = aggregateStandings(ratings, beersMap);
        console.log('Standings computed:', JSON.stringify(standings, null, 2));

        // Step 5: Build summary for the model (top beers only)
        const summary = {
            eventId: trimmedEventId,
            totalRatings: ratings.length,
            totalBeers: standings.length,
            beers: standings, // Already sorted by ranking
        };

        // Step 6: Generate final script using Bedrock Claude
        // NOTE: Model only generates script — all math was done above
        const finalText = await generateFinalScript(summary);
        console.log('Final script generated:', finalText.substring(0, 200) + '...');

        // Step 7: Generate TTS audio (stub for now)
        const { audioKey, audioUrl, ttsGenerated } = await generateTtsAudio(finalText, trimmedEventId);

        // Step 8: Store final announcement in DynamoDB
        await storeFinalAnnouncement(trimmedEventId, finalText, audioKey);

        // Step 9: Return success response
        return buildResponse(200, {
            message: 'Final announcement generated successfully',
            text: finalText,
            audioUrl: ttsGenerated ? audioUrl : null,
            audioPlaceholder: !ttsGenerated ? audioUrl : undefined,
            eventClosed: true,
            standings: standings.slice(0, 3).map(b => ({
                place: standings.indexOf(b) + 1,
                beerName: b.beerName,
                averageRating: b.averageRating,
                ratingCount: b.ratingCount,
            })),
        });

    } catch (error) {
        console.error('Unexpected error:', error);
        return buildResponse(500, { 
            message: 'Failed to generate final announcement. Please try again.',
            error: error.message,
        });
    }
};
