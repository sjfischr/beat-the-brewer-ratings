/**
 * Beat the Brewer - API Client
 *
 * Plain ES6+, no frameworks. Multi-event aware: the active event is resolved at
 * runtime from the URL (?eventId=...) or the events API, so nothing is hardcoded
 * per competition.
 */

// ===========================================
// Configuration - Lambda Function URLs
// ===========================================
// These persist across `sam deploy`, so they rarely change. After a FRESH deploy,
// re-copy them from the CloudFormation stack outputs.

const SUBMIT_RATING_URL = 'https://ju4ym2fwwpe7xccgnriiu3xuyq0izufd.lambda-url.us-east-1.on.aws/';
const GET_RATINGS_SUMMARY_URL = 'https://2zqxg5mnwh4kbsahi23pnffuuu0qabmw.lambda-url.us-east-1.on.aws/';
const GET_BEERS_URL = 'https://mytnsspdmbw2kbsvi7sjk5g5ym0zssse.lambda-url.us-east-1.on.aws/';
const UPSERT_BEER_URL = 'https://rfir4rftjoglcbfa5wsapjf4xm0lfbew.lambda-url.us-east-1.on.aws/';
const DELETE_BEER_URL = 'https://6c5fka7xa6744ukgtwg7juqzwy0eoxjl.lambda-url.us-east-1.on.aws/';
const GET_LIVE_ANNOUNCEMENT_URL = 'https://hp64oasmgwivca5zsgswcagp4q0whyya.lambda-url.us-east-1.on.aws/';
const GENERATE_FINAL_ANNOUNCEMENT_URL = 'https://nhmqhdelk65kqafrjvfb4xsuwi0nnufx.lambda-url.us-east-1.on.aws/';
const RESET_RATINGS_URL = 'https://2enhgrk664jmsukcyn76tzoi4y0riybr.lambda-url.us-east-1.on.aws/';

// NEW endpoint added in the multi-event rework. Paste the `EventsApiUrl` stack
// output here after running `sam deploy`.
const EVENTS_API_URL = 'https://REPLACE_WITH_EventsApiUrl_FROM_STACK_OUTPUTS/';

// Fallback event id used only if no ?eventId= is present and the events API can't
// resolve an active event (e.g. brand-new deploy). Keeps the page from breaking.
const FALLBACK_EVENT_ID = 'novabeat2025';

// ===========================================
// Event resolution (multi-event)
// ===========================================

let CURRENT_EVENT = null;     // full event config object
let CURRENT_EVENT_ID = null;  // resolved event id string

function getEventIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('eventId') || params.get('event') || null;
}

/**
 * Fetch an event config from the events API.
 * @param {object} opts - { eventId } to fetch a specific event, or {} for the active one
 * @returns {Promise<object|null>}
 */
async function fetchEvent(opts = {}) {
    if (!EVENTS_API_URL || EVENTS_API_URL.includes('REPLACE_WITH')) {
        console.warn('EVENTS_API_URL not configured; falling back to URL/default event id.');
        return null;
    }
    const query = opts.eventId
        ? `?eventId=${encodeURIComponent(opts.eventId)}`
        : '?active=true';
    const response = await fetch(`${EVENTS_API_URL}${query}`, {
        headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.event || null;
}

/**
 * Resolve the current event once. Order of preference:
 *   1. ?eventId= in the URL (QR-code friendly, explicit)
 *   2. the active event from the events API
 *   3. FALLBACK_EVENT_ID
 * @returns {Promise<object|null>} the resolved event config (may be null)
 */
async function resolveEvent() {
    if (CURRENT_EVENT_ID) return CURRENT_EVENT;

    const urlId = getEventIdFromUrl();
    let ev = null;
    try {
        ev = await fetchEvent(urlId ? { eventId: urlId } : {});
    } catch (e) {
        console.error('Error resolving event:', e);
    }

    CURRENT_EVENT = ev;
    CURRENT_EVENT_ID = ev?.eventId || urlId || FALLBACK_EVENT_ID;
    return ev;
}

function getEventId() {
    return CURRENT_EVENT_ID || getEventIdFromUrl() || FALLBACK_EVENT_ID;
}

function getCurrentEvent() {
    return CURRENT_EVENT;
}

/**
 * Apply an event's branding to any matching elements on the page.
 * Elements opt in via data attributes:
 *   data-brand="displayName" | "clubName" | "subtitle"
 */
function applyBranding(ev) {
    if (!ev) return;
    const map = {
        displayName: ev.displayName,
        clubName: ev.clubName,
        subtitle: ev.subtitle,
    };
    document.querySelectorAll('[data-brand]').forEach(el => {
        const key = el.getAttribute('data-brand');
        if (map[key]) el.textContent = map[key];
    });
    if (ev.displayName) {
        document.title = `${ev.displayName} – Beat the Brewer`;
    }
}

// ===========================================
// Voter token (server-side dedup) + legacy local vote cache
// ===========================================

const VOTER_TOKEN_KEY = 'beatTheBrewerVoterToken';
const VOTES_STORAGE_KEY = 'beatTheBrewerVotes';

function getVoterToken() {
    try {
        let token = localStorage.getItem(VOTER_TOKEN_KEY);
        if (!token) {
            token = (window.crypto && crypto.randomUUID)
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            localStorage.setItem(VOTER_TOKEN_KEY, token);
        }
        return token;
    } catch (e) {
        // localStorage unavailable (private mode); fall back to a per-session token.
        return `session-${Math.random().toString(16).slice(2)}`;
    }
}

function getVotes() {
    try {
        const stored = localStorage.getItem(VOTES_STORAGE_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        return {};
    }
}

function voteKey(beerId) {
    return `${getEventId()}:${beerId}`;
}

function hasVotedFor(beerId) {
    return getVotes()[voteKey(beerId)] === true;
}

function markAsVoted(beerId) {
    try {
        const votes = getVotes();
        votes[voteKey(beerId)] = true;
        localStorage.setItem(VOTES_STORAGE_KEY, JSON.stringify(votes));
    } catch (e) {
        console.error('Error saving vote to localStorage:', e);
    }
}

// ===========================================
// Events CRUD (admin)
// ===========================================

async function listEvents() {
    const response = await fetch(EVENTS_API_URL, { headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error('Failed to list events');
    const data = await response.json();
    return data.events || [];
}

async function saveEvent(ev) {
    const response = await fetch(EVENTS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upsert', event: ev }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to save event');
    }
    return (await response.json()).event;
}

async function activateEvent(eventId) {
    const response = await fetch(EVENTS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'activate', eventId }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to activate event');
    }
    return (await response.json()).event;
}

// ===========================================
// Beer CRUD Operations
// ===========================================

async function fetchBeers(showAll = false, eventId = getEventId()) {
    let url = `${GET_BEERS_URL}?eventId=${encodeURIComponent(eventId)}`;
    if (showAll) url += '&showAll=true';

    const response = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to fetch beers');
    }
    const data = await response.json();
    return data.beers || [];
}

async function saveBeer(beer) {
    const payload = {
        eventId: beer.eventId || getEventId(),
        beerId: beer.beerId,
        name: beer.name,
        brewer: beer.brewer || '',
        ingredients: beer.ingredients || '',
        style: beer.style || '',
        abv: beer.abv,
        active: beer.active !== undefined ? beer.active : true,
    };

    const response = await fetch(UPSERT_BEER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to save beer');
    }
    return await response.json();
}

async function deleteBeer(eventId, beerId) {
    const url = `${DELETE_BEER_URL}?eventId=${encodeURIComponent(eventId)}&beerId=${encodeURIComponent(beerId)}`;
    const response = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to delete beer');
    }
    return await response.json();
}

async function resetRatings(eventId = getEventId()) {
    const response = await fetch(RESET_RATINGS_URL, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId }),
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to reset ratings');
    }
    const result = await response.json();
    try { localStorage.removeItem(VOTES_STORAGE_KEY); } catch (e) {}
    return result;
}

/**
 * Populate a <select> element with active beers from the API.
 */
async function populateBeerSelect(selectId = 'beer', placeholder = 'Select a beer...') {
    const selectEl = document.getElementById(selectId);
    if (!selectEl) return;

    try {
        selectEl.innerHTML = `<option value="">${placeholder}</option>`;
        selectEl.disabled = true;

        const beers = await fetchBeers();
        const activeBeers = beers.filter(b => b.active !== false);

        selectEl.innerHTML = `<option value="">${placeholder}</option>`;
        activeBeers.forEach(beer => {
            const option = document.createElement('option');
            option.value = beer.beerId;
            const abvText = beer.abv != null ? ` (${beer.abv}% ABV)` : '';
            option.textContent = `${beer.name}${abvText}`;
            selectEl.appendChild(option);
        });

        selectEl.disabled = false;
    } catch (error) {
        console.error('Error populating beer select:', error);
        selectEl.innerHTML = `<option value="">Error loading beers</option>`;
        selectEl.disabled = true;
    }
}

// ===========================================
// Submit Rating
// ===========================================

async function submitRating(ratingData) {
    const { beerId, rating, comments } = ratingData;
    const eventId = ratingData.eventId || getEventId();

    if (!beerId || beerId.trim() === '') {
        throw new Error('Please select a beer.');
    }
    const numericRating = parseInt(rating, 10);
    if (isNaN(numericRating) || numericRating < 1 || numericRating > 10) {
        throw new Error('Rating must be between 1 and 10.');
    }
    if (hasVotedFor(beerId)) {
        throw new Error('You have already voted for this beer. One vote per beer per device, please! 😇');
    }

    const payload = {
        eventId,
        beerId,
        rating: numericRating,
        comment: comments || '',
        voterToken: getVoterToken(),
    };

    const response = await fetch(SUBMIT_RATING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 409) {
            markAsVoted(beerId); // sync local cache with server truth
        }
        throw new Error(errorData.message || 'Failed to submit rating. Please try again.');
    }

    const result = await response.json();
    markAsVoted(beerId);
    return result;
}

// ===========================================
// Load Ratings Summary
// ===========================================

async function loadRatingsSummary() {
    const loadingEl = document.getElementById('loading');
    const errorEl = document.getElementById('error');
    const resultsContentEl = document.getElementById('results-content');
    const beersTbody = document.getElementById('beers-table-body');
    const commentsTbody = document.getElementById('comments-table-body');
    const noRatingsEl = document.getElementById('no-ratings');
    const noCommentsEl = document.getElementById('no-comments');
    const summaryTable = document.getElementById('summary-table');
    const commentsTable = document.getElementById('comments-table');

    loadingEl.classList.remove('hidden');
    errorEl.classList.add('hidden');
    resultsContentEl.classList.add('hidden');

    try {
        const response = await fetch(
            `${GET_RATINGS_SUMMARY_URL}?eventId=${encodeURIComponent(getEventId())}`,
            { headers: { 'Content-Type': 'application/json' } }
        );
        if (!response.ok) throw new Error('Failed to fetch ratings summary');

        const data = await response.json();
        renderBeersTable(data.beers || [], beersTbody, noRatingsEl, summaryTable);
        renderCommentsTable(data.ratings || [], commentsTbody, noCommentsEl, commentsTable);

        loadingEl.classList.add('hidden');
        resultsContentEl.classList.remove('hidden');
    } catch (error) {
        console.error('Error loading ratings summary:', error);
        loadingEl.classList.add('hidden');
        errorEl.classList.remove('hidden');
    }
}

function renderBeersTable(beers, tbody, noDataEl, tableEl) {
    tbody.innerHTML = '';
    if (!beers || beers.length === 0) {
        tableEl.classList.add('hidden');
        noDataEl.classList.remove('hidden');
        return;
    }
    tableEl.classList.remove('hidden');
    noDataEl.classList.add('hidden');

    const sortedBeers = [...beers].sort((a, b) => b.averageRating - a.averageRating);

    sortedBeers.forEach((beer, index) => {
        const row = document.createElement('tr');
        if (index === 0) row.classList.add('leader-row');
        const abvDisplay = beer.beerAbv != null ? `${beer.beerAbv}%` : '-';
        const brewerLine = beer.brewer
            ? `<div class="beer-sub">${escapeHtml(beer.brewer)}</div>` : '';
        const ingredientsLine = beer.ingredients
            ? `<div class="beer-sub beer-ingredients">${escapeHtml(beer.ingredients)}</div>` : '';
        row.innerHTML = `
            <td>${escapeHtml(beer.beerName || beer.beerId)}${brewerLine}${ingredientsLine}</td>
            <td>${abvDisplay}</td>
            <td>${beer.averageRating != null ? beer.averageRating.toFixed(1) : '-'}</td>
            <td>${beer.ratingCount || 0}</td>
        `;
        tbody.appendChild(row);
    });
}

function renderCommentsTable(ratings, tbody, noDataEl, tableEl) {
    tbody.innerHTML = '';
    const ratingsWithComments = (ratings || []).filter(r => r.comment && r.comment.trim() !== '');
    if (ratingsWithComments.length === 0) {
        tableEl.classList.add('hidden');
        noDataEl.classList.remove('hidden');
        return;
    }
    tableEl.classList.remove('hidden');
    noDataEl.classList.add('hidden');

    const sortedRatings = [...ratingsWithComments].sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    sortedRatings.forEach(rating => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${escapeHtml(rating.beerName || rating.beerId)}</td>
            <td>${rating.rating}</td>
            <td>${escapeHtml(rating.comment)}</td>
        `;
        tbody.appendChild(row);
    });
}

// ===========================================
// Utility
// ===========================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===========================================
// Beer Admin Functions
// ===========================================

async function initBeerAdmin() {
    const form = document.getElementById('beer-form');
    const clearBtn = document.getElementById('clear-btn');
    const messageEl = document.getElementById('message');
    const beerIdInput = document.getElementById('beer-id');

    await refreshBeerTable();

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const beer = {
            eventId: getEventId(),
            beerId: document.getElementById('beer-id').value.trim(),
            name: document.getElementById('beer-name').value.trim(),
            brewer: document.getElementById('beer-brewer').value.trim(),
            ingredients: document.getElementById('beer-ingredients').value.trim(),
            style: document.getElementById('beer-style')?.value.trim() || '',
            abv: parseFloat(document.getElementById('beer-abv').value) || null,
            active: document.getElementById('beer-active').checked,
        };

        if (!beer.beerId) { showAdminMessage('Beer ID is required.', 'error'); return; }
        if (!beer.name) { showAdminMessage('Display name is required.', 'error'); return; }

        try {
            await saveBeer(beer);
            showAdminMessage(`Beer "${beer.name}" saved successfully! 🍺`, 'success');
            clearBeerForm();
            await refreshBeerTable();
        } catch (error) {
            showAdminMessage(error.message || 'Failed to save beer.', 'error');
        }
    });

    clearBtn.addEventListener('click', () => {
        clearBeerForm();
        beerIdInput.disabled = false;
    });

    function showAdminMessage(text, type) {
        messageEl.textContent = text;
        messageEl.className = `message ${type}`;
        messageEl.classList.remove('hidden');
        if (type === 'success') {
            setTimeout(() => messageEl.classList.add('hidden'), 3000);
        }
    }

    function clearBeerForm() {
        form.reset();
        document.getElementById('beer-active').checked = true;
        document.getElementById('beer-id').disabled = false;
    }
}

async function refreshBeerTable() {
    const loadingEl = document.getElementById('loading');
    const tableEl = document.getElementById('beers-table');
    const tbody = document.getElementById('beers-table-body');
    const noBeersEl = document.getElementById('no-beers');

    loadingEl.classList.remove('hidden');
    tableEl.classList.add('hidden');
    noBeersEl.classList.add('hidden');

    try {
        const beers = await fetchBeers(true);
        loadingEl.classList.add('hidden');

        if (!beers || beers.length === 0) {
            noBeersEl.classList.remove('hidden');
            return;
        }
        beers.sort((a, b) => a.beerId.localeCompare(b.beerId));
        tbody.innerHTML = '';

        beers.forEach(beer => {
            const row = document.createElement('tr');
            const statusClass = beer.active !== false ? 'status-active' : 'status-inactive';
            const statusText = beer.active !== false ? 'Active' : 'Inactive';
            const abvDisplay = beer.abv != null ? `${beer.abv}%` : '-';
            row.innerHTML = `
                <td>${escapeHtml(beer.beerId)}</td>
                <td>${escapeHtml(beer.name)}</td>
                <td>${escapeHtml(beer.brewer || '-')}</td>
                <td>${escapeHtml(beer.ingredients || '-')}</td>
                <td>${abvDisplay}</td>
                <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                <td>
                    <button class="btn-action btn-edit" data-beer-id="${escapeHtml(beer.beerId)}">Edit</button>
                    <button class="btn-action btn-delete" data-beer-id="${escapeHtml(beer.beerId)}" data-beer-name="${escapeHtml(beer.name)}">Delete</button>
                </td>
            `;
            tbody.appendChild(row);
        });

        tableEl.classList.remove('hidden');
        attachBeerRowListeners(beers);
    } catch (error) {
        console.error('Error loading beers:', error);
        loadingEl.classList.add('hidden');
        noBeersEl.textContent = 'Error loading beers. Please refresh.';
        noBeersEl.classList.remove('hidden');
    }
}

function attachBeerRowListeners(beers) {
    const beerMap = new Map(beers.map(b => [b.beerId, b]));

    document.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const beer = beerMap.get(btn.dataset.beerId);
            if (beer) loadBeerIntoForm(beer);
        });
    });

    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const beerId = btn.dataset.beerId;
            const beerName = btn.dataset.beerName;
            if (!confirm(`Are you sure you want to delete "${beerName}"?`)) return;
            try {
                await deleteBeer(getEventId(), beerId);
                await refreshBeerTable();
            } catch (error) {
                alert('Failed to delete beer: ' + error.message);
            }
        });
    });
}

function loadBeerIntoForm(beer) {
    document.getElementById('beer-id').value = beer.beerId;
    document.getElementById('beer-id').disabled = true;
    document.getElementById('beer-name').value = beer.name || '';
    document.getElementById('beer-brewer').value = beer.brewer || '';
    document.getElementById('beer-ingredients').value = beer.ingredients || '';
    const styleEl = document.getElementById('beer-style');
    if (styleEl) styleEl.value = beer.style || '';
    document.getElementById('beer-abv').value = beer.abv != null ? beer.abv : '';
    document.getElementById('beer-active').checked = beer.active !== false;
    document.getElementById('beer-form').scrollIntoView({ behavior: 'smooth' });
}

// ===========================================
// Live Announcement (read-only banner)
// ===========================================

async function fetchLiveAnnouncement() {
    const url = `${GET_LIVE_ANNOUNCEMENT_URL}?eventId=${encodeURIComponent(getEventId())}`;
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to fetch announcement');
    }
    return await response.json();
}

/**
 * Load the latest announcement into the results page banner (if present).
 */
async function loadLatestAnnouncementBanner() {
    const bannerEl = document.getElementById('announcement-banner');
    const bannerTextEl = document.getElementById('announcement-banner-text');
    if (!bannerEl || !bannerTextEl) return;

    try {
        const data = await fetchLiveAnnouncement();
        if (data.text) {
            bannerTextEl.textContent = data.text;
            bannerEl.classList.remove('hidden');
        } else {
            bannerEl.classList.add('hidden');
        }
    } catch (error) {
        console.error('Error loading announcement banner:', error);
        bannerEl.classList.add('hidden');
    }
}

// ===========================================
// Conclude Event
// ===========================================

async function concludeEvent() {
    const concludeBtn = document.getElementById('conclude-event-button');
    const messageEl = document.getElementById('conclude-message');
    const resultEl = document.getElementById('final-announcement-result');
    const textEl = document.getElementById('final-announcement-text');
    const audioEl = document.getElementById('final-announcement-audio');

    concludeBtn.disabled = true;
    concludeBtn.textContent = '⏳ Generating final announcement...';
    messageEl.classList.add('hidden');
    resultEl.classList.remove('visible');

    try {
        const response = await fetch(GENERATE_FINAL_ANNOUNCEMENT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventId: getEventId() }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || 'Failed to conclude event');
        }

        const data = await response.json();
        messageEl.textContent = '✅ Event concluded! Ratings are now closed.';
        messageEl.className = 'message success';
        messageEl.classList.remove('hidden');

        if (data.text) {
            textEl.textContent = data.text;
            resultEl.classList.add('visible');
        }
        if (data.audioUrl) {
            audioEl.src = data.audioUrl;
            audioEl.style.display = 'block';
            try { await audioEl.play(); } catch (e) { /* autoplay may be blocked */ }
        } else {
            audioEl.style.display = 'none';
        }

        concludeBtn.textContent = '✓ Event Concluded';
        concludeBtn.disabled = true;
    } catch (error) {
        console.error('Error concluding event:', error);
        messageEl.textContent = `❌ Error: ${error.message}`;
        messageEl.className = 'message error';
        messageEl.classList.remove('hidden');
        concludeBtn.disabled = false;
        concludeBtn.textContent = '🏆 Conclude Event & Generate Final Announcement';
    }
}
