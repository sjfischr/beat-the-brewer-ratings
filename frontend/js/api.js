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
const GET_LIVE_ANNOUNCEMENT_URL = 'https://hp64oasmgwivca5zsgswcagp4q0whyya.lambda-url.us-east-1.on.aws/';
const GENERATE_FINAL_ANNOUNCEMENT_URL = 'https://nhmqhdelk65kqafrjvfb4xsuwi0nnufx.lambda-url.us-east-1.on.aws/';
const RESET_RATINGS_URL = 'https://2enhgrk664jmsukcyn76tzoi4y0riybr.lambda-url.us-east-1.on.aws/';

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
 * Reset all ratings for an event (keeps beers intact).
 * @param {string} [eventId] - Event identifier (defaults to EVENT_ID)
 * @returns {Promise<Object>} - API response with deletedCount
 */
async function resetRatings(eventId = EVENT_ID) {
    try {
        console.log('Resetting ratings for event:', eventId);

        const response = await fetch(RESET_RATINGS_URL, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ eventId }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to reset ratings');
        }

        const result = await response.json();
        console.log('Ratings reset successfully:', result);
        
        // Also clear local storage votes
        localStorage.removeItem(VOTES_STORAGE_KEY);
        
        return result;
    } catch (error) {
        console.error('Error resetting ratings:', error);
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

// ===========================================
// Announcer Functions
// ===========================================

// Polling interval for announcer (in milliseconds)
const ANNOUNCER_POLL_INTERVAL = 30000; // 30 seconds

// Store for announcer state
let announcerIntervalId = null;
let announcementHistory = [];

// Web Speech API settings
// DISABLED: Using ElevenLabs TTS from backend instead
let speechEnabled = false; // Browser speech disabled - using ElevenLabs

// Audio element for ElevenLabs playback
let announcementAudioEl = null;

/**
 * Play announcement audio from ElevenLabs TTS.
 * @param {string} audioUrl - URL to the audio file
 */
function playAnnouncementAudio(audioUrl) {
    try {
        // Create or reuse audio element
        if (!announcementAudioEl) {
            announcementAudioEl = new Audio();
            announcementAudioEl.id = 'elevenlabs-audio';
        }

        // Stop any current playback
        announcementAudioEl.pause();
        announcementAudioEl.currentTime = 0;

        // Set new source and play
        announcementAudioEl.src = audioUrl;
        announcementAudioEl.play()
            .then(() => {
                console.log('Playing ElevenLabs audio:', audioUrl);
            })
            .catch(error => {
                console.error('Failed to play audio (may need user interaction):', error);
            });
    } catch (error) {
        console.error('Error playing announcement audio:', error);
    }
}

/**
 * Speak text aloud using the Web Speech API (if available).
 * Wrapped in feature detection for older browser compatibility.
 * NOTE: This is a fallback - ElevenLabs TTS is preferred.
 * @param {string} text - The text to speak
 */
function speakAnnouncement(text) {
    // Feature detection for Web Speech API
    if (!speechEnabled || !('speechSynthesis' in window)) {
        console.log('Speech synthesis not available or disabled');
        return;
    }

    try {
        // Cancel any ongoing speech
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        
        // Configure voice settings for a friendly, enthusiastic tone
        utterance.rate = 0.95;  // Slightly slower for clarity
        utterance.pitch = 1.05; // Slightly higher for energy
        utterance.volume = 1.0;

        // Try to find a good English voice
        const voices = window.speechSynthesis.getVoices();
        const preferredVoice = voices.find(v => 
            v.lang.startsWith('en') && v.name.includes('Male')
        ) || voices.find(v => 
            v.lang.startsWith('en-US')
        ) || voices[0];

        if (preferredVoice) {
            utterance.voice = preferredVoice;
        }

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event.error);
        };

        window.speechSynthesis.speak(utterance);
        console.log('Speaking announcement:', text.substring(0, 50) + '...');
    } catch (error) {
        console.error('Error with speech synthesis:', error);
    }
}

/**
 * Toggle speech synthesis on/off.
 * @param {boolean} enabled - Whether speech should be enabled
 */
function setSpeechEnabled(enabled) {
    speechEnabled = enabled;
    if (!enabled && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
    console.log(`Speech synthesis ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Render an announcement to the UI.
 * Updates the main announcement text and optionally adds to the log.
 * @param {string} text - The announcement text
 * @param {object} options - Optional settings
 * @param {boolean} options.addToLog - Whether to add to the announcement log (default: true)
 * @param {boolean} options.speak - Whether to speak the announcement (default: false, ElevenLabs used instead)
 * @param {object} options.leader - Optional leader data to display
 * @param {string} options.audioUrl - Optional audio URL from ElevenLabs TTS
 */
function renderAnnouncement(text, options = {}) {
    const { addToLog: shouldLog = true, speak = false, leader = null, audioUrl = null } = options;

    const announcementTextEl = document.getElementById('announcement-text');
    const announcementLogEl = document.getElementById('announcement-log');
    const leaderDisplayEl = document.getElementById('leader-display');
    const leaderNameEl = document.getElementById('leader-name');
    const leaderStatsEl = document.getElementById('leader-stats');

    // Update main announcement text
    if (announcementTextEl) {
        announcementTextEl.textContent = `"${text}"`;
        announcementTextEl.classList.remove('waiting');
    }

    // Add to log with timestamp
    if (shouldLog && announcementLogEl) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString();

        announcementHistory.unshift({ time: timeStr, text });
        
        // Keep only last 10 entries
        if (announcementHistory.length > 10) {
            announcementHistory = announcementHistory.slice(0, 10);
        }

        announcementLogEl.innerHTML = announcementHistory.map(entry => `
            <div class="log-entry">
                <div class="log-time">${escapeHtml(entry.time)}</div>
                <div>${escapeHtml(entry.text)}</div>
            </div>
        `).join('');
    }

    // Update leader display if provided
    if (leader && leaderDisplayEl && leaderNameEl && leaderStatsEl) {
        leaderDisplayEl.style.display = 'block';
        leaderNameEl.textContent = leader.beerName || leader.beerId;
        leaderStatsEl.textContent = `${leader.averageRating?.toFixed(1) || '-'} avg · ${leader.ratingCount || 0} ratings`;
    }

    // Play ElevenLabs audio if URL provided
    if (audioUrl) {
        playAnnouncementAudio(audioUrl);
    } else if (speak) {
        // Fallback to browser speech if enabled
        speakAnnouncement(text);
    }
}

/**
 * Fetch the latest live announcement from the API.
 * @returns {Promise<Object>} - { hasUpdate, text?, summary? }
 */
async function fetchLiveAnnouncement() {
    try {
        const url = `${GET_LIVE_ANNOUNCEMENT_URL}?eventId=${encodeURIComponent(EVENT_ID)}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to fetch announcement');
        }

        return await response.json();
    } catch (error) {
        console.error('Error fetching live announcement:', error);
        throw error;
    }
}

/**
 * Initialize the announcer page.
 * Sets up polling loop and displays announcements.
 * Immediately fetches one announcement on load to prime the UI.
 */
function initAnnouncer() {
    const announcementTextEl = document.getElementById('announcement-text');
    const statusDotEl = document.getElementById('status-dot');
    const statusTextEl = document.getElementById('status-text');
    const leaderDisplayEl = document.getElementById('leader-display');

    // Preload voices for Web Speech API (some browsers need this)
    if ('speechSynthesis' in window) {
        window.speechSynthesis.getVoices();
        // Some browsers fire a voiceschanged event
        window.speechSynthesis.onvoiceschanged = () => {
            window.speechSynthesis.getVoices();
        };
    }

    // Update status indicator
    function setStatus(isOk, message) {
        if (statusDotEl) {
            statusDotEl.classList.toggle('error', !isOk);
        }
        if (statusTextEl) {
            statusTextEl.textContent = message;
        }
    }

    // Poll for announcements
    async function pollForAnnouncement() {
        try {
            setStatus(true, 'Checking for updates...');

            const data = await fetchLiveAnnouncement();

            if (data.hasUpdate && data.text) {
                // New announcement! Use the renderAnnouncement helper
                renderAnnouncement(data.text, {
                    addToLog: true,
                    speak: false, // Don't use browser speech
                    leader: data.summary?.leader || null,
                    audioUrl: data.audioUrl || null, // Play ElevenLabs audio if available
                });

                setStatus(true, `Updated at ${new Date().toLocaleTimeString()}`);
            } else {
                setStatus(true, `No new updates · Last check: ${new Date().toLocaleTimeString()}`);
            }

        } catch (error) {
            console.error('Announcer poll error:', error);
            setStatus(false, `Error: ${error.message}`);
        }
    }

    // Initial poll (primes the UI, okay if hasUpdate is false)
    pollForAnnouncement();

    // Start polling loop
    announcerIntervalId = setInterval(pollForAnnouncement, ANNOUNCER_POLL_INTERVAL);

    console.log(`Announcer initialized. Polling every ${ANNOUNCER_POLL_INTERVAL / 1000} seconds.`);
    console.log(`Web Speech API available: ${'speechSynthesis' in window}`);
}

/**
 * Fetch the last announcement text (for use on results page banner).
 * This is a lightweight call that doesn't trigger a new announcement generation.
 * @returns {Promise<string|null>} - The last announcement text or null
 */
async function fetchLastAnnouncement() {
    try {
        const data = await fetchLiveAnnouncement();
        // Return the text if there was an update, otherwise we got hasUpdate: false
        // which means no new ratings since last call
        return data.text || null;
    } catch (error) {
        console.error('Error fetching last announcement:', error);
        return null;
    }
}

/**
 * Load the latest announcement into the results page banner.
 * Called by results.html to show a small "Latest Update" section.
 */
async function loadLatestAnnouncementBanner() {
    const bannerEl = document.getElementById('announcement-banner');
    const bannerTextEl = document.getElementById('announcement-banner-text');
    
    if (!bannerEl || !bannerTextEl) {
        return; // Banner elements not on this page
    }

    try {
        const data = await fetchLiveAnnouncement();
        
        if (data.text) {
            bannerTextEl.textContent = data.text;
            bannerEl.classList.remove('hidden');
        } else if (data.hasUpdate === false) {
            // No update, could show a cached message or hide
            bannerEl.classList.add('hidden');
        }
    } catch (error) {
        console.error('Error loading announcement banner:', error);
        bannerEl.classList.add('hidden');
    }
}

// ===========================================
// Conclude Event Functions
// ===========================================

/**
 * Conclude the event: close voting and generate the final announcement.
 * Called from admin.html when the admin clicks "Conclude Event".
 */
async function concludeEvent() {
    const concludeBtn = document.getElementById('conclude-event-button');
    const messageEl = document.getElementById('conclude-message');
    const resultEl = document.getElementById('final-announcement-result');
    const textEl = document.getElementById('final-announcement-text');
    const audioEl = document.getElementById('final-announcement-audio');

    // Show loading state
    concludeBtn.disabled = true;
    concludeBtn.textContent = '⏳ Generating final announcement...';
    messageEl.classList.add('hidden');
    resultEl.classList.remove('visible');

    try {
        const response = await fetch(GENERATE_FINAL_ANNOUNCEMENT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ eventId: EVENT_ID }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || 'Failed to conclude event');
        }

        const data = await response.json();
        console.log('Event concluded:', data);

        // Show success message
        messageEl.textContent = '✅ Event concluded! Ratings are now closed.';
        messageEl.className = 'message success';
        messageEl.classList.remove('hidden');

        // Display the final announcement text
        if (data.text) {
            textEl.textContent = data.text;
            resultEl.classList.add('visible');
        }

        // Set up audio player if URL is available
        if (data.audioUrl) {
            audioEl.src = data.audioUrl;
            audioEl.style.display = 'block';
            // Try to play automatically (may be blocked by browser)
            try {
                await audioEl.play();
            } catch (playError) {
                console.log('Auto-play blocked, user can click play manually');
            }
        } else {
            audioEl.style.display = 'none';
        }

        // Update button to show completed state
        concludeBtn.textContent = '✓ Event Concluded';
        concludeBtn.disabled = true;

    } catch (error) {
        console.error('Error concluding event:', error);
        
        // Show error message
        messageEl.textContent = `❌ Error: ${error.message}`;
        messageEl.className = 'message error';
        messageEl.classList.remove('hidden');

        // Re-enable button for retry
        concludeBtn.disabled = false;
        concludeBtn.textContent = '🏆 Conclude Event & Generate Final Announcement';
    }
}
