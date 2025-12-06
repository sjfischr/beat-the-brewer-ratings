/**
 * Beat the Brewer - Get Ratings Summary Lambda Handler
 * 
 * GET /ratings-summary?eventId={eventId}
 * 
 * Retrieves and aggregates all ratings for an event.
 * Beer names and ABVs are fetched from the beers table.
 * 
 * Response format:
 * {
 *   "beers": [
 *     {
 *       "beerId": "beerA",
 *       "beerName": "Little Full, Lotta Sap",
 *       "beerAbv": 7.1,
 *       "averageRating": 7.8,
 *       "ratingCount": 12
 *     }
 *   ],
 *   "ratings": [
 *     {
 *       "beerId": "beerA",
 *       "beerName": "Little Full, Lotta Sap",
 *       "beerAbv": 7.1,
 *       "rating": 8,
 *       "comment": "Nice fruitcake vibe",
 *       "createdAt": "2025-09-01T02:34:56Z"
 *     }
 *   ]
 * }
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

// ===========================================
// Configuration
// ===========================================

// Table names from environment variables
const TABLE_NAME = process.env.TABLE_NAME;
const BEERS_TABLE_NAME = process.env.BEERS_TABLE_NAME;

// Initialize DynamoDB Document Client
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Response headers (CORS handled by Function URL config)
const RESPONSE_HEADERS = {
    'Content-Type': 'application/json',
};

// ===========================================
// Beer Metadata Helpers
// ===========================================

/**
 * Fetch all beers for an event from the beers table.
 * @param {string} eventId - The event identifier
 * @returns {Promise<Map<string, object>>} - Map of beerId -> beer item
 */
async function fetchBeerMetadata(eventId) {
    const beerMap = new Map();

    if (!BEERS_TABLE_NAME) {
        console.warn('BEERS_TABLE_NAME not configured, beer metadata will not be available');
        return beerMap;
    }

    try {
        const result = await docClient.send(new QueryCommand({
            TableName: BEERS_TABLE_NAME,
            KeyConditionExpression: 'eventId = :eventId',
            ExpressionAttributeValues: {
                ':eventId': eventId,
            },
        }));

        for (const item of result.Items || []) {
            beerMap.set(item.beerId, item);
        }

        console.log(`Fetched ${beerMap.size} beers from beers table for event ${eventId}`);
    } catch (error) {
        console.error('Error fetching beer metadata:', error);
        // Continue without beer metadata rather than failing the whole request
    }

    return beerMap;
}

/**
 * Get the display name for a beer ID from the metadata map.
 * Falls back to beerId if not found.
 * @param {string} beerId - The beer identifier
 * @param {Map<string, object>} beerMap - Map of beerId -> beer item
 * @returns {string} - Display name
 */
function getBeerName(beerId, beerMap) {
    const beerItem = beerMap.get(beerId);
    return beerItem?.name || beerId;
}

/**
 * Get the ABV for a beer ID from the metadata map.
 * @param {string} beerId - The beer identifier
 * @param {Map<string, object>} beerMap - Map of beerId -> beer item
 * @returns {number|null} - ABV or null if not found
 */
function getBeerAbv(beerId, beerMap) {
    const beerItem = beerMap.get(beerId);
    return beerItem?.abv ?? null;
}

// ===========================================
// Helper Functions
// ===========================================

/**
 * Build a response object with CORS headers.
 * @param {number} statusCode - HTTP status code
 * @param {object} body - Response body object
 * @returns {object} - API Gateway response object
 */
function buildResponse(statusCode, body) {
    return {
        statusCode,
        headers: RESPONSE_HEADERS,
        body: JSON.stringify(body),
    };
}

/**
 * Aggregate ratings by beer.
 * Only includes ratings for beers that exist in the beers table.
 * @param {Array} ratings - Array of rating items from DynamoDB
 * @param {Map<string, object>} beerMap - Map of beerId -> beer item
 * @returns {Array} - Array of beer summary objects
 */
function aggregateByBeer(ratings, beerMap) {
    const beerAggMap = {};

    for (const rating of ratings) {
        const { beerId, rating: score } = rating;

        // Skip ratings for beers that don't exist in the beers table
        if (!beerMap.has(beerId)) {
            console.log(`Skipping rating for unknown/deleted beer: ${beerId}`);
            continue;
        }

        if (!beerAggMap[beerId]) {
            beerAggMap[beerId] = {
                beerId,
                beerName: getBeerName(beerId, beerMap),
                beerAbv: getBeerAbv(beerId, beerMap),
                totalScore: 0,
                ratingCount: 0,
            };
        }

        beerAggMap[beerId].totalScore += score;
        beerAggMap[beerId].ratingCount += 1;
    }

    // Calculate averages and format output
    const beers = Object.values(beerAggMap).map(beer => ({
        beerName: beer.beerName,
        beerAbv: beer.beerAbv,
        averageRating: Math.round((beer.totalScore / beer.ratingCount) * 10) / 10,
        ratingCount: beer.ratingCount,
    }));

    // Sort by average rating descending
    beers.sort((a, b) => b.averageRating - a.averageRating);

    return beers;
}

/**
 * Format ratings into flat array with beer names and ABVs.
 * Only includes ratings for beers that exist in the beers table.
 * @param {Array} ratings - Array of rating items from DynamoDB
 * @param {Map<string, object>} beerMap - Map of beerId -> beer item
 * @returns {Array} - Array of formatted rating objects
 */
function formatRatings(ratings, beerMap) {
    return ratings
        .filter(rating => beerMap.has(rating.beerId)) // Only include ratings for existing beers
        .map(rating => ({
            beerName: getBeerName(rating.beerId, beerMap),
            beerAbv: getBeerAbv(rating.beerId, beerMap),
            rating: rating.rating,
            comment: rating.comment || '',
            createdAt: rating.createdAt || rating.timestamp, // Support both field names
        }));
}

// ===========================================
// Lambda Handler
// ===========================================

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    // Handle CORS preflight request (works for both API Gateway and Function URLs)
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    if (httpMethod === 'OPTIONS') {
        return buildResponse(200, {});
    }

    try {
        // Check that TABLE_NAME is configured
        if (!TABLE_NAME) {
            console.error('TABLE_NAME environment variable is not set');
            return buildResponse(500, { message: 'Server configuration error' });
        }

        // Get eventId from query string parameters (supports both API Gateway and Function URLs)
        const eventId = event.queryStringParameters?.eventId;

        if (!eventId || eventId.trim() === '') {
            console.log('Missing eventId query parameter');
            return buildResponse(400, { message: 'eventId query parameter is required' });
        }

        const trimmedEventId = eventId.trim();
        console.log('Fetching ratings for eventId:', trimmedEventId);

        // Query DynamoDB for all ratings with this eventId
        const queryResult = await docClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'eventId = :eventId',
            ExpressionAttributeValues: {
                ':eventId': trimmedEventId,
            },
        }));

        const ratings = queryResult.Items || [];
        console.log(`Found ${ratings.length} ratings for event ${trimmedEventId}`);

        // Fetch beer metadata from beers table
        const beerMap = await fetchBeerMetadata(trimmedEventId);

        // Aggregate ratings by beer
        const beers = aggregateByBeer(ratings, beerMap);

        // Format individual ratings
        const formattedRatings = formatRatings(ratings, beerMap);

        // Extract recent comments for ticker display (last 10 with non-empty comments)
        const recentComments = formattedRatings
            .filter(r => r.comment && r.comment.trim().length > 0)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 10)
            .map(r => ({
                comment: r.comment,
                beerName: r.beerName,
                rating: r.rating,
            }));

        // Build response
        const response = {
            beers,
            ratings: formattedRatings,
            recentComments,
        };

        return buildResponse(200, response);

    } catch (error) {
        console.error('Unexpected error:', error);
        return buildResponse(500, { message: 'Internal server error' });
    }
};
