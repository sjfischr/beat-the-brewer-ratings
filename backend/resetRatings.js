/**
 * Beat the Brewer - Reset Ratings Lambda Handler
 * 
 * DELETE /reset-ratings
 * 
 * Deletes all ratings for an event but leaves beers intact.
 * Also resets the announcements table state.
 * 
 * Expected request body:
 * {
 *   "eventId": "string"    // Required: Event identifier
 * }
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, DeleteCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

// ===========================================
// Configuration
// ===========================================

const TABLE_NAME = process.env.TABLE_NAME;
const ANNOUNCEMENTS_TABLE_NAME = process.env.ANNOUNCEMENTS_TABLE_NAME;

// Initialize DynamoDB Document Client
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Response headers
const RESPONSE_HEADERS = {
    'Content-Type': 'application/json',
};

// ===========================================
// Helper Functions
// ===========================================

/**
 * Build a response object.
 * @param {number} statusCode - HTTP status code
 * @param {object} body - Response body object
 * @returns {object} - Lambda response object
 */
function buildResponse(statusCode, body) {
    return {
        statusCode,
        headers: RESPONSE_HEADERS,
        body: JSON.stringify(body),
    };
}

// ===========================================
// Main Handler
// ===========================================

exports.handler = async (event) => {
    console.log('Reset Ratings invoked:', JSON.stringify(event));

    // Only allow DELETE or POST method
    const method = event.requestContext?.http?.method || event.httpMethod;
    if (method !== 'DELETE' && method !== 'POST') {
        return buildResponse(405, { error: 'Method not allowed' });
    }

    try {
        // Parse request body
        let body;
        try {
            body = event.body ? JSON.parse(event.body) : {};
        } catch (parseError) {
            return buildResponse(400, { error: 'Invalid JSON in request body' });
        }

        const { eventId } = body;

        // Validate eventId
        if (!eventId || typeof eventId !== 'string' || eventId.trim() === '') {
            return buildResponse(400, { error: 'eventId is required and must be a non-empty string' });
        }

        // Query all ratings for this event
        const queryResult = await docClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'eventId = :eid',
            ExpressionAttributeValues: {
                ':eid': eventId,
            },
            ProjectionExpression: 'eventId, ratingId',
        }));

        const ratings = queryResult.Items || [];
        console.log(`Found ${ratings.length} ratings to delete for event: ${eventId}`);

        // Delete each rating
        let deletedCount = 0;
        for (const rating of ratings) {
            await docClient.send(new DeleteCommand({
                TableName: TABLE_NAME,
                Key: {
                    eventId: rating.eventId,
                    ratingId: rating.ratingId,
                },
            }));
            deletedCount++;
        }

        // Reset the announcements table state for this event
        await docClient.send(new PutCommand({
            TableName: ANNOUNCEMENTS_TABLE_NAME,
            Item: {
                eventId,
                acceptingRatings: true,
                lastProcessedTimestamp: null,
                lastRatingCount: 0,
                lastAnnouncementText: null,
                finalText: null,
                finalAudioKey: null,
                finalGeneratedAt: null,
            },
        }));

        console.log(`Successfully deleted ${deletedCount} ratings and reset announcements for event: ${eventId}`);

        return buildResponse(200, {
            success: true,
            message: `Deleted ${deletedCount} ratings and reset event state`,
            deletedCount,
        });

    } catch (error) {
        console.error('Error resetting ratings:', error);
        return buildResponse(500, {
            error: 'Failed to reset ratings',
            details: error.message,
        });
    }
};
