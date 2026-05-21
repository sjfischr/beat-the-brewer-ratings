/**
 * Beat the Brewer - Events API Lambda Handler
 *
 * One Function URL, multiple actions, so the frontend only needs a single new endpoint.
 *
 *   GET  /                       -> list all events (newest first)
 *   GET  /?eventId=hmart-june    -> get one event config
 *   GET  /?active=true           -> get the currently active event
 *   POST /  { action: "upsert",   event: {...} }
 *   POST /  { action: "activate", eventId: "hmart-june" }
 *
 * Event record shape:
 * {
 *   eventId, displayName, clubName, subtitle,
 *   status: "setup" | "open" | "closed",
 *   isActive: boolean,
 *   persona: { name, voiceId, flavorNote },
 *   createdAt, updatedAt
 * }
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    ScanCommand,
    UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const EVENTS_TABLE_NAME = process.env.EVENTS_TABLE_NAME;

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const RESPONSE_HEADERS = { 'Content-Type': 'application/json' };

const VALID_STATUSES = ['setup', 'open', 'closed'];
const EVENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function buildResponse(statusCode, body) {
    return { statusCode, headers: RESPONSE_HEADERS, body: JSON.stringify(body) };
}

async function listEvents() {
    const result = await docClient.send(new ScanCommand({ TableName: EVENTS_TABLE_NAME }));
    const events = result.Items || [];
    events.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return events;
}

async function getEvent(eventId) {
    const result = await docClient.send(new GetCommand({
        TableName: EVENTS_TABLE_NAME,
        Key: { eventId },
    }));
    return result.Item || null;
}

async function getActiveEvent() {
    // Small table; a scan with a filter is fine.
    const result = await docClient.send(new ScanCommand({
        TableName: EVENTS_TABLE_NAME,
        FilterExpression: 'isActive = :true',
        ExpressionAttributeValues: { ':true': true },
    }));
    const items = result.Items || [];
    // Prefer an open active event, otherwise the most recently updated active one.
    items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return items.find(e => e.status === 'open') || items[0] || null;
}

function validateEvent(ev) {
    if (!ev || typeof ev !== 'object') return 'event object is required';
    if (!ev.eventId || typeof ev.eventId !== 'string' || !EVENT_ID_PATTERN.test(ev.eventId)) {
        return 'eventId is required (letters, numbers, dashes, underscores only)';
    }
    if (!ev.displayName || typeof ev.displayName !== 'string' || ev.displayName.trim() === '') {
        return 'displayName is required';
    }
    if (ev.status !== undefined && !VALID_STATUSES.includes(ev.status)) {
        return `status must be one of: ${VALID_STATUSES.join(', ')}`;
    }
    return null;
}

async function upsertEvent(ev) {
    const existing = await getEvent(ev.eventId.trim());
    const now = new Date().toISOString();

    const persona = ev.persona || existing?.persona || {};

    const item = {
        eventId: ev.eventId.trim(),
        displayName: ev.displayName.trim(),
        clubName: (ev.clubName ?? existing?.clubName ?? '').toString().trim(),
        subtitle: (ev.subtitle ?? existing?.subtitle ?? '').toString().trim(),
        status: ev.status || existing?.status || 'setup',
        isActive: ev.isActive !== undefined ? !!ev.isActive : (existing?.isActive || false),
        persona: {
            name: (persona.name ?? 'Sam Calagione').toString(),
            voiceId: (persona.voiceId ?? 'yKGyS0hnJchyz15wFwrA').toString(),
            flavorNote: (persona.flavorNote ?? '').toString(),
        },
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };

    await docClient.send(new PutCommand({ TableName: EVENTS_TABLE_NAME, Item: item }));
    return item;
}

async function activateEvent(eventId) {
    const target = await getEvent(eventId);
    if (!target) {
        return { error: `Event "${eventId}" not found` };
    }

    const all = await listEvents();
    const now = new Date().toISOString();

    // Clear isActive on everyone else, set it on the target.
    await Promise.all(all.map(ev =>
        docClient.send(new UpdateCommand({
            TableName: EVENTS_TABLE_NAME,
            Key: { eventId: ev.eventId },
            UpdateExpression: 'SET isActive = :a, updatedAt = :u',
            ExpressionAttributeValues: {
                ':a': ev.eventId === eventId,
                ':u': now,
            },
        }))
    ));

    return { event: { ...target, isActive: true, updatedAt: now } };
}

exports.handler = async (event) => {
    const method = event.httpMethod || event.requestContext?.http?.method;
    if (method === 'OPTIONS') return buildResponse(200, {});

    try {
        if (!EVENTS_TABLE_NAME) {
            console.error('EVENTS_TABLE_NAME is not set');
            return buildResponse(500, { message: 'Server configuration error' });
        }

        if (method === 'GET') {
            const qs = event.queryStringParameters || {};
            if (qs.active === 'true') {
                const active = await getActiveEvent();
                return buildResponse(200, { event: active });
            }
            if (qs.eventId) {
                const ev = await getEvent(qs.eventId.trim());
                if (!ev) return buildResponse(404, { message: 'Event not found' });
                return buildResponse(200, { event: ev });
            }
            const events = await listEvents();
            return buildResponse(200, { events });
        }

        if (method === 'POST') {
            let body;
            try {
                body = JSON.parse(event.body || '{}');
            } catch {
                return buildResponse(400, { message: 'Invalid JSON in request body' });
            }

            const action = body.action || 'upsert';

            if (action === 'activate') {
                if (!body.eventId) return buildResponse(400, { message: 'eventId is required to activate' });
                const result = await activateEvent(body.eventId.trim());
                if (result.error) return buildResponse(404, { message: result.error });
                return buildResponse(200, { message: 'ok', ...result });
            }

            if (action === 'upsert') {
                const ev = body.event || body; // accept a bare event object too
                const validationError = validateEvent(ev);
                if (validationError) return buildResponse(400, { message: validationError });
                const saved = await upsertEvent(ev);
                return buildResponse(200, { message: 'ok', event: saved });
            }

            return buildResponse(400, { message: `Unknown action: ${action}` });
        }

        return buildResponse(405, { message: 'Method not allowed' });
    } catch (error) {
        console.error('Unexpected error:', error);
        return buildResponse(500, { message: 'Internal server error' });
    }
};
