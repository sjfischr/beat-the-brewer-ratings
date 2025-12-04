/**
 * Beat the Brewer - Get Beers Lambda Handler
 * 
 * GET /beers?eventId={eventId}
 * 
 * Retrieves all beers configured for an event.
 * 
 * Response format:
 * {
 *   "beers": [
 *     {
 *       "eventId": "novabeat2025",
 *       "beerId": "beer-a",
 *       "name": "Beer A",
 *       "abv": 7.1,
 *       "active": true
 *     }
 *   ]
 * }
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

// ===========================================
// Configuration
// ===========================================

// Table name from environment variable
const BEERS_TABLE_NAME = process.env.BEERS_TABLE_NAME;

// Initialize DynamoDB Document Client
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Response headers (CORS handled by Function URL config)
const RESPONSE_HEADERS = {
    'Content-Type': 'application/json',
};

// ===========================================
// Helper Functions
// ===========================================

/**
 * Build a response object with CORS headers.
 * @param {number} statusCode - HTTP status code
 * @param {object} body - Response body object
 * @returns {object} - API Gateway/Function URL response object
 */
function buildResponse(statusCode, body) {
    return {
        statusCode,
        headers: RESPONSE_HEADERS,
        body: JSON.stringify(body),
    };
}

// ===========================================
// Lambda Handler
// ===========================================

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    // Handle CORS preflight request
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    if (httpMethod === 'OPTIONS') {
        return buildResponse(200, {});
    }

    try {
        // Check that BEERS_TABLE_NAME is configured
        if (!BEERS_TABLE_NAME) {
            console.error('BEERS_TABLE_NAME environment variable is not set');
            return buildResponse(500, { message: 'Server configuration error' });
        }

        // Get eventId from query string parameters
        const eventId = event.queryStringParameters?.eventId;

        if (!eventId || eventId.trim() === '') {
            console.log('Missing eventId query parameter');
            return buildResponse(400, { message: 'eventId query parameter is required' });
        }

        console.log('Fetching beers for eventId:', eventId);

        // Query DynamoDB for all beers with this eventId
        const queryResult = await docClient.send(new QueryCommand({
            TableName: BEERS_TABLE_NAME,
            KeyConditionExpression: 'eventId = :eventId',
            ExpressionAttributeValues: {
                ':eventId': eventId.trim(),
            },
        }));

        const beers = queryResult.Items || [];
        console.log(`Found ${beers.length} beers for event ${eventId}`);

        // Filter to only active beers by default (unless showAll=true)
        const showAll = event.queryStringParameters?.showAll === 'true';
        const filteredBeers = showAll 
            ? beers 
            : beers.filter(beer => beer.active !== false);

        // Sort by beerId for consistent ordering
        filteredBeers.sort((a, b) => a.beerId.localeCompare(b.beerId));

        return buildResponse(200, { beers: filteredBeers });

    } catch (error) {
        console.error('Unexpected error:', error);
        return buildResponse(500, { message: 'Internal server error' });
    }
};
