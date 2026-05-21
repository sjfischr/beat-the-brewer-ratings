/**
 * Beat the Brewer - Submit Rating Lambda Handler
 *
 * POST /submit-rating
 *
 * Stores a beer rating in DynamoDB.
 *
 * Expected request body:
 * {
 *   "eventId":    "string",   // Required
 *   "beerId":     "string",   // Required
 *   "rating":     number,     // Required: 1-10
 *   "comment":    "string",   // Optional: max 500 chars
 *   "voterToken": "string"    // Optional: per-device id for server-side dedup
 * }
 *
 * Server-side duplicate prevention: when a voterToken is supplied, the rating
 * is keyed deterministically as `${beerId}#${voterToken}` and written with a
 * conditional put, so a given device can only rate a given beer once (returns
 * 409 on a repeat). Without a token we fall back to a random id (no dedup).
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME = process.env.TABLE_NAME;
const ANNOUNCEMENTS_TABLE_NAME = process.env.ANNOUNCEMENTS_TABLE_NAME;

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const RESPONSE_HEADERS = { 'Content-Type': 'application/json' };

function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function buildResponse(statusCode, body) {
    return { statusCode, headers: RESPONSE_HEADERS, body: JSON.stringify(body) };
}

function validateRequest(body) {
    const { eventId, beerId, rating, comment } = body;

    if (!eventId || typeof eventId !== 'string' || eventId.trim() === '') {
        return 'eventId is required and must be a non-empty string';
    }
    if (!beerId || typeof beerId !== 'string' || beerId.trim() === '') {
        return 'beerId is required and must be a non-empty string';
    }
    if (rating === undefined || rating === null) {
        return 'rating is required';
    }
    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 10) {
        return 'rating must be an integer between 1 and 10';
    }
    if (comment !== undefined && comment !== null && comment !== '') {
        if (typeof comment !== 'string') return 'comment must be a string';
        if (comment.length > 500) return 'comment must be 500 characters or less';
    }
    return null;
}

exports.handler = async (event) => {
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    if (httpMethod === 'OPTIONS') return buildResponse(200, {});

    try {
        if (!TABLE_NAME) {
            console.error('TABLE_NAME environment variable is not set');
            return buildResponse(500, { message: 'Server configuration error' });
        }

        let body;
        try {
            body = JSON.parse(event.body || '{}');
        } catch (parseError) {
            return buildResponse(400, { message: 'Invalid JSON in request body' });
        }

        const validationError = validateRequest(body);
        if (validationError) {
            return buildResponse(400, { message: validationError });
        }

        const { eventId, beerId, rating, comment, voterToken } = body;
        const trimmedEventId = eventId.trim();
        const trimmedBeerId = beerId.trim();

        // Reject ratings if the event has been concluded.
        if (ANNOUNCEMENTS_TABLE_NAME) {
            try {
                const announcementResult = await docClient.send(new GetCommand({
                    TableName: ANNOUNCEMENTS_TABLE_NAME,
                    Key: { eventId: trimmedEventId },
                }));
                if (announcementResult.Item && announcementResult.Item.acceptingRatings === false) {
                    return buildResponse(403, {
                        message: 'This event is closed for ratings. Thanks for participating!',
                    });
                }
            } catch (announcementError) {
                console.warn('Failed to check acceptingRatings, proceeding:', announcementError.message);
            }
        }

        // Deterministic id when we have a voter token => server-side dedup.
        const hasToken = typeof voterToken === 'string' && voterToken.trim() !== '';
        const ratingId = hasToken
            ? `${trimmedBeerId}#${voterToken.trim()}`
            : generateUUID();

        const item = {
            eventId: trimmedEventId,
            ratingId,
            beerId: trimmedBeerId,
            rating: Number(rating),
            createdAt: new Date().toISOString(),
        };
        if (comment && typeof comment === 'string' && comment.trim() !== '') {
            item.comment = comment.trim();
        }
        if (hasToken) {
            item.voterToken = voterToken.trim();
        }

        try {
            await docClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: item,
                // Only enforce single-vote when we have a token to key on.
                ...(hasToken ? { ConditionExpression: 'attribute_not_exists(ratingId)' } : {}),
            }));
        } catch (putError) {
            if (putError.name === 'ConditionalCheckFailedException') {
                return buildResponse(409, {
                    message: 'You have already rated this beer on this device.',
                });
            }
            throw putError;
        }

        return buildResponse(200, { message: 'ok' });
    } catch (error) {
        console.error('Unexpected error:', error);
        return buildResponse(500, { message: 'Internal server error' });
    }
};
