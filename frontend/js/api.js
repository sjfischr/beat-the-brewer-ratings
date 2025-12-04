/**
 * Beat the Brewer - API Client
 * 
 * Client-side logic for submitting ratings and loading results.
 * Plain ES6+, no frameworks.
 */

// ===========================================
// Configuration
// ===========================================

// Lambda Function URLs from CloudFormation deployment
const SUBMIT_RATING_URL = 'https://ju4ym2fwwpe7xccgnriiu3xuyq0izufd.lambda-url.us-east-1.on.aws/';
const GET_RATINGS_SUMMARY_URL = 'https://2zqxg5mnwh4kbsahi23pnffuuu0qabmw.lambda-url.us-east-1.on.aws/';
const GET_BEERS_URL = 'https://mytnsspdmbw2kbsvi7sjk5g5ym0zssse.lambda-url.us-east-1.on.aws/';
const UPSERT_BEER_URL = 'https://rfir4rftjoglcbfa5wsapjf4xm0lfbew.lambda-url.us-east-1.on.aws/';
const DELETE_BEER_URL = 'https://6c5fka7xa6744ukgtwg7juqzwy0eoxjl.lambda-url.us-east-1.on.aws/';

// Event ID for this competition
const EVENT_ID = 'novabeat2025';

// LocalStorage key for tracking votes
const VOTES_STORAGE_KEY = 'beatTheBrewerVotes';

// ===========================================
// Vote Tracking (localStorage)
// ===========================================

/**
 * Get the current votes object from localStorage
 * @returns {Object} - Object with beerId keys and boolean values
 */
function getVotes() {
    try {
        const stored = localStorage.getItem(VOTES_STORAGE_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        console.error('Error reading votes from localStorage:', e);
        return {};
    }
}

/**
 * Check if user has already voted for a specific beer
 * @param {string} beerId - The beer identifier
 * @returns {boolean} - True if already voted
 */
function hasVotedFor(beerId) {
    const votes = getVotes();
    return votes[beerId] === true;
}

/**
 * Mark a beer as voted in localStorage
 * @param {string} beerId - The beer identifier
 */
function markAsVoted(beerId) {
    try {
        const votes = getVotes();
        votes[beerId] = true;
        localStorage.setItem(VOTES_STORAGE_KEY, JSON.stringify(votes));
    } catch (e) {
        console.error('Error saving vote to localStorage:', e);
    }
}

// ===========================================
// Beer CRUD Operations
// ===========================================

/**
 * Fetch all beers for the current event.
 * @param {boolean} [showAll=false] - If true, include inactive beers
 * @returns {Promise<Array>} - Array of beer objects { eventId, beerId, name, abv, active }
 */
async function fetchBeers(showAll = false) {
    try {
        let url = `${GET_BEERS_URL}?eventId=${encodeURIComponent(EVENT_ID)}`;
        if (showAll) {
            url += '&showAll=true';
        }

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || 'Failed to fetch beers');
        }

        const data = await response.json();
        console.log('Beers fetched:', data.beers);
        return data.beers || [];
    } catch (error) {
        console.error('Error fetching beers:', error);
        throw error;
    }
}

/**
 * Save (create or update) a beer.
 * @param {Object} beer - Beer object { eventId, beerId, name, abv, active }
 * @returns {Promise<Object>} - API response
 */
async function saveBeer(beer) {
    try {
        const payload = {
            eventId: beer.eventId || EVENT_ID,
            beerId: beer.beerId,
            name: beer.name,
            abv: beer.abv,
            active: beer.active !== undefined ? beer.active : true,
        };

        console.log('Saving beer:', payload);

        const response = await fetch(UPSERT_BEER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || 'Failed to save beer');
        }

        const result = await response.json();
        console.log('Beer saved successfully:', result);
        return result;
    } catch (error) {
        console.error('Error saving beer:', error);
        throw error;
    }
}

/**
 * Delete a beer.
 * @param {string} eventId - Event identifier
 * @param {string} beerId - Beer identifier
 * @returns {Promise<Object>} - API response
 */
async function deleteBeer(eventId, beerId) {
    try {
        const url = `${DELETE_BEER_URL}?eventId=${encodeURIComponent(eventId)}&beerId=${encodeURIComponent(beerId)}`;
        console.log('Deleting beer:', { eventId, beerId });

        const response = await fetch(url, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || 'Failed to delete beer');
        }

        const result = await response.json();
        console.log('Beer deleted successfully:', result);
        return result;
    } catch (error) {
        console.error('Error deleting beer:', error);
        throw error;
    }
}

/**
 * Populate a <select> element with active beers from the API.
 * Used on index.html to dynamically fill the beer dropdown.
 * @param {string} selectId - ID of the <select> element to populate
 * @param {string} [placeholder='Select a beer...'] - Placeholder option text
 */
async function populateBeerSelect(selectId = 'beer', placeholder = 'Select a beer...') {
    const selectEl = document.getElementById(selectId);
    if (!selectEl) {
        console.error(`Select element with id "${selectId}" not found`);
        return;
    }

    try {
        // Show loading state
        selectEl.innerHTML = `<option value="">${placeholder}</option>`;
        selectEl.disabled = true;

        const beers = await fetchBeers();

        // Filter to only active beers
        const activeBeers = beers.filter(b => b.active !== false);

        // Clear and populate select
        selectEl.innerHTML = `<option value="">${placeholder}</option>`;

        activeBeers.forEach(beer => {
            const option = document.createElement('option');
            option.value = beer.beerId;
            // Show ABV if available
            const abvText = beer.abv != null ? ` (${beer.abv}% ABV)` : '';
            option.textContent = `${beer.name}${abvText}`;
            selectEl.appendChild(option);
        });

        selectEl.disabled = false;
        console.log(`Populated beer select with ${activeBeers.length} beers`);
    } catch (error) {
        console.error('Error populating beer select:', error);
        // Keep the placeholder but show an error option
        selectEl.innerHTML = `<option value="">Error loading beers</option>`;
        selectEl.disabled = true;
    }
}

// ===========================================
// Submit Rating
// ===========================================

/**
 * Submit a beer rating.
 * Called by index.html on form submit.
 * 
 * @param {Object} ratingData - Rating data object
 * @param {string} ratingData.eventId - Event identifier
 * @param {string} ratingData.beerId - Beer identifier
 * @param {number} ratingData.rating - Rating value (1-10)
 * @param {string} [ratingData.comments] - Optional comment
 * @returns {Promise<Object>} - API response
 * @throws {Error} - If validation fails or API call fails
 */
async function submitRating(ratingData) {
    const { beerId, rating, comments } = ratingData;
    
    // Use provided eventId or fall back to constant
    const eventId = ratingData.eventId || EVENT_ID;

    // --- Validation ---
    
    // beerId is required
    if (!beerId || beerId.trim() === '') {
        throw new Error('Please select a beer.');
    }

    // rating must be between 1 and 10
    const numericRating = parseInt(rating, 10);
    if (isNaN(numericRating) || numericRating < 1 || numericRating > 10) {
        throw new Error('Rating must be between 1 and 10.');
    }

    // --- Check for duplicate vote ---
    
    if (hasVotedFor(beerId)) {
        throw new Error('You have already voted for this beer. One vote per beer per device, please! 😇');
    }

    // --- Submit to API ---
    
    const payload = {
        eventId,
        beerId,
        rating: numericRating,
        comment: comments || ''
    };

    console.log('Submitting rating:', payload);

    const response = await fetch(SUBMIT_RATING_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    // Handle non-OK responses
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to submit rating. Please try again.');
    }

    const result = await response.json();

    // --- Success: Mark as voted ---
    markAsVoted(beerId);

    console.log('Rating submitted successfully:', result);
    return result;
}

// ===========================================
// Load Ratings Summary
// ===========================================

/**
 * Load ratings summary from API and render to DOM.
 * Called by results.html on page load.
 */
async function loadRatingsSummary() {
    // Get DOM elements
    const loadingEl = document.getElementById('loading');
    const errorEl = document.getElementById('error');
    const resultsContentEl = document.getElementById('results-content');
    const beersTbody = document.getElementById('beers-table-body');
    const commentsTbody = document.getElementById('comments-table-body');
    const noRatingsEl = document.getElementById('no-ratings');
    const noCommentsEl = document.getElementById('no-comments');
    const summaryTable = document.getElementById('summary-table');
    const commentsTable = document.getElementById('comments-table');

    // Show loading state
    loadingEl.classList.remove('hidden');
    errorEl.classList.add('hidden');
    resultsContentEl.classList.add('hidden');

    try {
        // Fetch data from API
        const response = await fetch(
            `${GET_RATINGS_SUMMARY_URL}?eventId=${encodeURIComponent(EVENT_ID)}`,
            {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            }
        );

        if (!response.ok) {
            throw new Error('Failed to fetch ratings summary');
        }

        const data = await response.json();
        console.log('Ratings summary loaded:', data);

        // --- Render beers summary table ---
        renderBeersTable(data.beers || [], beersTbody, noRatingsEl, summaryTable);

        // --- Render comments table ---
        renderCommentsTable(data.ratings || [], commentsTbody, noCommentsEl, commentsTable);

        // Hide loading, show results
        loadingEl.classList.add('hidden');
        resultsContentEl.classList.remove('hidden');

    } catch (error) {
        console.error('Error loading ratings summary:', error);
        
        // Hide loading, show error
        loadingEl.classList.add('hidden');
        errorEl.classList.remove('hidden');
    }
}

/**
 * Render the beers summary table
 * @param {Array} beers - Array of beer summary objects
 * @param {HTMLElement} tbody - Table body element
 * @param {HTMLElement} noDataEl - "No data" message element
 * @param {HTMLElement} tableEl - Table element
 */
function renderBeersTable(beers, tbody, noDataEl, tableEl) {
    // Clear existing rows
    tbody.innerHTML = '';

    if (!beers || beers.length === 0) {
        // No ratings yet
        tableEl.classList.add('hidden');
        noDataEl.classList.remove('hidden');
        return;
    }

    // Show table, hide "no data" message
    tableEl.classList.remove('hidden');
    noDataEl.classList.add('hidden');

    // Sort by average rating (highest first)
    const sortedBeers = [...beers].sort((a, b) => b.averageRating - a.averageRating);

    // Render each beer row
    sortedBeers.forEach((beer, index) => {
        const row = document.createElement('tr');
        
        // Highlight the leader
        if (index === 0) {
            row.classList.add('leader-row');
        }

        // Format ABV display
        const abvDisplay = beer.beerAbv != null ? `${beer.beerAbv}%` : '-';

        row.innerHTML = `
            <td>${escapeHtml(beer.beerName || beer.beerId)}</td>
            <td>${abvDisplay}</td>
            <td>${beer.averageRating != null ? beer.averageRating.toFixed(1) : '-'}</td>
            <td>${beer.ratingCount || 0}</td>
        `;
        
        tbody.appendChild(row);
    });
}

/**
 * Render the comments table
 * @param {Array} ratings - Array of individual rating objects with comments
 * @param {HTMLElement} tbody - Table body element
 * @param {HTMLElement} noDataEl - "No data" message element
 * @param {HTMLElement} tableEl - Table element
 */
function renderCommentsTable(ratings, tbody, noDataEl, tableEl) {
    // Clear existing rows
    tbody.innerHTML = '';

    // Filter to only ratings with comments
    const ratingsWithComments = (ratings || []).filter(r => r.comment && r.comment.trim() !== '');

    if (ratingsWithComments.length === 0) {
        // No comments yet
        tableEl.classList.add('hidden');
        noDataEl.classList.remove('hidden');
        return;
    }

    // Show table, hide "no data" message
    tableEl.classList.remove('hidden');
    noDataEl.classList.add('hidden');

    // Sort by createdAt (newest first)
    const sortedRatings = [...ratingsWithComments].sort((a, b) => {
        return new Date(b.createdAt) - new Date(a.createdAt);
    });

    // Render each comment row
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
// Utility Functions
// ===========================================

/**
 * Escape HTML to prevent XSS attacks
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===========================================
// Beer Admin Functions
// ===========================================

/**
 * Initialize the beer admin page.
 * Sets up form handlers and loads the beer list.
 */
async function initBeerAdmin() {
    const form = document.getElementById('beer-form');
    const clearBtn = document.getElementById('clear-btn');
    const messageEl = document.getElementById('message');
    const beerIdInput = document.getElementById('beer-id');

    // Load initial beer list
    await refreshBeerTable();

    // Handle form submission
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const beer = {
            eventId: EVENT_ID,
            beerId: document.getElementById('beer-id').value.trim(),
            name: document.getElementById('beer-name').value.trim(),
            abv: parseFloat(document.getElementById('beer-abv').value) || null,
            active: document.getElementById('beer-active').checked,
        };

        // Validate
        if (!beer.beerId) {
            showAdminMessage('Beer ID is required.', 'error');
            return;
        }
        if (!beer.name) {
            showAdminMessage('Display name is required.', 'error');
            return;
        }

        try {
            await saveBeer(beer);
            showAdminMessage(`Beer "${beer.name}" saved successfully! 🍺`, 'success');
            clearBeerForm();
            await refreshBeerTable();
        } catch (error) {
            showAdminMessage(error.message || 'Failed to save beer.', 'error');
        }
    });

    // Handle clear button
    clearBtn.addEventListener('click', () => {
        clearBeerForm();
        beerIdInput.disabled = false;
    });

    /**
     * Show a message on the admin page
     */
    function showAdminMessage(text, type) {
        messageEl.textContent = text;
        messageEl.className = `message ${type}`;
        messageEl.classList.remove('hidden');
        
        // Auto-hide success messages
        if (type === 'success') {
            setTimeout(() => {
                messageEl.classList.add('hidden');
            }, 3000);
        }
    }

    /**
     * Clear the beer form
     */
    function clearBeerForm() {
        form.reset();
        document.getElementById('beer-active').checked = true;
        document.getElementById('beer-id').disabled = false;
    }
}

/**
 * Refresh the beer table on the admin page.
 */
async function refreshBeerTable() {
    const loadingEl = document.getElementById('loading');
    const tableEl = document.getElementById('beers-table');
    const tbody = document.getElementById('beers-table-body');
    const noBeersEl = document.getElementById('no-beers');

    // Show loading
    loadingEl.classList.remove('hidden');
    tableEl.classList.add('hidden');
    noBeersEl.classList.add('hidden');

    try {
        const beers = await fetchBeers(true); // showAll=true for admin

        // Hide loading
        loadingEl.classList.add('hidden');

        if (!beers || beers.length === 0) {
            noBeersEl.classList.remove('hidden');
            return;
        }

        // Sort by beerId
        beers.sort((a, b) => a.beerId.localeCompare(b.beerId));

        // Clear and populate table
        tbody.innerHTML = '';

        beers.forEach(beer => {
            const row = document.createElement('tr');
            const statusClass = beer.active !== false ? 'status-active' : 'status-inactive';
            const statusText = beer.active !== false ? 'Active' : 'Inactive';
            const abvDisplay = beer.abv != null ? `${beer.abv}%` : '-';

            row.innerHTML = `
                <td>${escapeHtml(beer.beerId)}</td>
                <td>${escapeHtml(beer.name)}</td>
                <td>${abvDisplay}</td>
                <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                <td>
                    <button class="btn-action btn-edit" data-beer-id="${escapeHtml(beer.beerId)}">Edit</button>
                    <button class="btn-action btn-delete" data-beer-id="${escapeHtml(beer.beerId)}" data-beer-name="${escapeHtml(beer.name)}">Delete</button>
                </td>
            `;

            tbody.appendChild(row);
        });

        // Show table
        tableEl.classList.remove('hidden');

        // Attach event listeners for edit/delete buttons
        attachBeerRowListeners(beers);

    } catch (error) {
        console.error('Error loading beers:', error);
        loadingEl.classList.add('hidden');
        noBeersEl.textContent = 'Error loading beers. Please refresh.';
        noBeersEl.classList.remove('hidden');
    }
}

/**
 * Attach click listeners to edit/delete buttons in the beer table.
 * @param {Array} beers - Array of beer objects for reference
 */
function attachBeerRowListeners(beers) {
    const beerMap = new Map(beers.map(b => [b.beerId, b]));

    // Edit buttons
    document.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const beerId = btn.dataset.beerId;
            const beer = beerMap.get(beerId);
            if (beer) {
                loadBeerIntoForm(beer);
            }
        });
    });

    // Delete buttons
    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const beerId = btn.dataset.beerId;
            const beerName = btn.dataset.beerName;

            if (!confirm(`Are you sure you want to delete "${beerName}"?`)) {
                return;
            }

            try {
                await deleteBeer(EVENT_ID, beerId);
                await refreshBeerTable();
            } catch (error) {
                alert('Failed to delete beer: ' + error.message);
            }
        });
    });
}

/**
 * Load a beer's data into the form for editing.
 * @param {Object} beer - Beer object to load
 */
function loadBeerIntoForm(beer) {
    document.getElementById('beer-id').value = beer.beerId;
    document.getElementById('beer-id').disabled = true; // Can't change ID when editing
    document.getElementById('beer-name').value = beer.name || '';
    document.getElementById('beer-abv').value = beer.abv != null ? beer.abv : '';
    document.getElementById('beer-active').checked = beer.active !== false;

    // Scroll to form
    document.getElementById('beer-form').scrollIntoView({ behavior: 'smooth' });
}
