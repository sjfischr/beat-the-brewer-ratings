/**
 * Beat the Brewer - Submit Rating Lambda Handler
 * 
 * POST /submit-rating
 * 
 * Receives a beer rating and stores it in DynamoDB.
 * 
 * Expected request body:
 * {
 *   "eventId": "string",      // Required: Event identifier
 *   "beerId": "string",       // Required: Beer identifier
 *   "rating": number,         // Required: Rating 1-10
 *   "comment": "string"       // Optional: User comment (max 500 chars)
 * }
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

// ===========================================
// Configuration
// ===========================================

// Table names from environment variables
const TABLE_NAME = process.env.TABLE_NAME;
const ANNOUNCEMENTS_TABLE_NAME = process.env.ANNOUNCEMENTS_TABLE_NAME;

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
 * Generate a UUID for the rating ID.
 * Uses crypto.randomUUID() if available (Node 16+), otherwise falls back to a simple generator.
 * @returns {string} - UUID string
 */
function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback: simple UUID v4 generator
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

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
 * Validate the request body.
 * @param {object} body - Parsed request body
 * @returns {string|null} - Error message if invalid, null if valid
 */
function validateRequest(body) {
    const { eventId, beerId, rating, comment } = body;

    // eventId: required, non-empty string
    if (!eventId || typeof eventId !== 'string' || eventId.trim() === '') {
        return 'eventId is required and must be a non-empty string';
    }

    // beerId: required, non-empty string
    if (!beerId || typeof beerId !== 'string' || beerId.trim() === '') {
        return 'beerId is required and must be a non-empty string';
    }

    // rating: required, integer 1-10
    if (rating === undefined || rating === null) {
        return 'rating is required';
    }
    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 10) {
        return 'rating must be an integer between 1 and 10';
    }

    // comment: optional, but if provided must be string with max 500 chars
    if (comment !== undefined && comment !== null && comment !== '') {
        if (typeof comment !== 'string') {
            return 'comment must be a string';
        }
        if (comment.length > 500) {
            return 'comment must be 500 characters or less';
        }
    }

    return null; // Valid
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
        const { eventId, beerId, rating, comment } = body;

        // Check if event is still accepting ratings
        if (ANNOUNCEMENTS_TABLE_NAME) {
            try {
                const announcementResult = await docClient.send(new GetCommand({
                    TableName: ANNOUNCEMENTS_TABLE_NAME,
                    Key: { eventId: eventId.trim() },
                }));

                if (announcementResult.Item && announcementResult.Item.acceptingRatings === false) {
                    console.log('Event is closed for ratings:', eventId);
                    return buildResponse(403, { 
                        message: 'This event is closed for ratings. Thanks for participating!' 
                    });
                }
            } catch (announcementError) {
                // Log but don't block rating submission if announcements table check fails
                console.warn('Failed to check acceptingRatings, proceeding with rating:', announcementError.message);
            }
        }
        const ratingId = generateUUID();
        const createdAt = new Date().toISOString();

        // Build DynamoDB item
        const item = {
            eventId: eventId.trim(),
            ratingId,
            beerId: beerId.trim(),
            rating: Number(rating),
            createdAt,
        };

        // Only include comment if provided and non-empty
        if (comment && typeof comment === 'string' && comment.trim() !== '') {
            item.comment = comment.trim();
        }

        console.log('Storing rating item:', JSON.stringify(item, null, 2));

        // Put item into DynamoDB
        await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item,
        }));

        console.log('Successfully stored rating:', ratingId);

        return buildResponse(200, { message: 'ok' });

    } catch (error) {
        console.error('Unexpected error:', error);
        return buildResponse(500, { message: 'Internal server error' });
    }
};
