/**
 * Beat the Brewer - Delete Beer Lambda Handler
 * 
 * DELETE /beers?eventId={eventId}&beerId={beerId}
 * 
 * Deletes a beer configuration.
 * 
 * Query parameters:
 *   eventId - Required: Event identifier
 *   beerId - Required: Beer identifier to delete
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

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

        // Get eventId and beerId from query string parameters
        const eventId = event.queryStringParameters?.eventId;
        const beerId = event.queryStringParameters?.beerId;

        if (!eventId || eventId.trim() === '') {
            console.log('Missing eventId query parameter');
            return buildResponse(400, { message: 'eventId query parameter is required' });
        }

        if (!beerId || beerId.trim() === '') {
            console.log('Missing beerId query parameter');
            return buildResponse(400, { message: 'beerId query parameter is required' });
        }

        console.log(`Deleting beer ${beerId} for event ${eventId}`);

        // Delete item from DynamoDB
        await docClient.send(new DeleteCommand({
            TableName: BEERS_TABLE_NAME,
            Key: {
                eventId: eventId.trim(),
                beerId: beerId.trim(),
            },
        }));

        console.log('Successfully deleted beer:', beerId);

        return buildResponse(200, { message: 'ok' });

    } catch (error) {
        console.error('Unexpected error:', error);
        return buildResponse(500, { message: 'Internal server error' });
    }
};
