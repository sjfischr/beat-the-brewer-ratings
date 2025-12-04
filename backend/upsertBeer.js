/**
 * Beat the Brewer - Upsert Beer Lambda Handler
 * 
 * POST /beers
 * 
 * Creates or updates a beer configuration.
 * 
 * Expected request body:
 * {
 *   "eventId": "novabeat2025",     // Required: Event identifier
 *   "beerId": "beer-a",            // Required: Beer identifier
 *   "name": "Beer A",              // Required: Display name
 *   "abv": 7.1,                    // Optional: Alcohol by volume
 *   "active": true                 // Optional: Whether beer is active (default true)
 * }
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

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

/**
 * Validate the request body.
 * @param {object} body - Parsed request body
 * @returns {string|null} - Error message if invalid, null if valid
 */
function validateRequest(body) {
    const { eventId, beerId, name, abv, active } = body;

    // eventId: required, non-empty string
    if (!eventId || typeof eventId !== 'string' || eventId.trim() === '') {
        return 'eventId is required and must be a non-empty string';
    }

    // beerId: required, non-empty string
    if (!beerId || typeof beerId !== 'string' || beerId.trim() === '') {
        return 'beerId is required and must be a non-empty string';
    }

    // name: required, non-empty string
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return 'name is required and must be a non-empty string';
    }

    // abv: optional, but if provided must be a number between 0 and 20
    if (abv !== undefined && abv !== null) {
        const numericAbv = Number(abv);
        if (isNaN(numericAbv) || numericAbv < 0 || numericAbv > 20) {
            return 'abv must be a number between 0 and 20';
        }
    }

    // active: optional, but if provided must be a boolean
    if (active !== undefined && active !== null && typeof active !== 'boolean') {
        return 'active must be a boolean';
    }

    return null; // Valid
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

        // Parse request body
        let body;
        try {
            body = JSON.parse(event.body || '{}');
        } catch (parseError) {
            console.error('Failed to parse request body:', parseError);
            return buildResponse(400, { message: 'Invalid JSON in request body' });
        }

        // Validate request
        const validationError = validateRequest(body);
        if (validationError) {
            console.log('Validation failed:', validationError);
            return buildResponse(400, { message: validationError });
        }

        // Extract and sanitize fields
        const { eventId, beerId, name, abv, active } = body;
        const updatedAt = new Date().toISOString();

        // Build DynamoDB item
        const item = {
            eventId: eventId.trim(),
            beerId: beerId.trim(),
            name: name.trim(),
            active: active !== false, // Default to true
            updatedAt,
        };

        // Only include abv if provided
        if (abv !== undefined && abv !== null) {
            item.abv = Number(abv);
        }

        console.log('Storing beer item:', JSON.stringify(item, null, 2));

        // Put item into DynamoDB (creates or overwrites)
        await docClient.send(new PutCommand({
            TableName: BEERS_TABLE_NAME,
            Item: item,
        }));

        console.log('Successfully stored beer:', beerId);

        return buildResponse(200, { message: 'ok', beer: item });

    } catch (error) {
        console.error('Unexpected error:', error);
        return buildResponse(500, { message: 'Internal server error' });
    }
};
