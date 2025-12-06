/**
 * Seed Ratings Script
 * 
 * Loads test ratings from seedData.json into DynamoDB.
 * Run with: node scripts/seedRatings.js
 * 
 * Prerequisites:
 * - AWS credentials configured
 * - npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
 */

const { DynamoDBClient } = require('../backend/node_modules/@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('../backend/node_modules/@aws-sdk/lib-dynamodb');
const fs = require('fs');
const path = require('path');

// Configuration
const TABLE_NAME = 'BeatTheBrewerRatings';
const REGION = 'us-east-1';

// Initialize DynamoDB client
const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Generate a UUID
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Generate a random timestamp within the last hour
 */
function randomTimestamp() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    const randomTime = oneHourAgo + Math.random() * (now - oneHourAgo);
    return new Date(randomTime).toISOString();
}

/**
 * Main seeding function
 */
async function seedRatings() {
    // Load seed data
    const seedDataPath = path.join(__dirname, 'seedData.json');
    
    if (!fs.existsSync(seedDataPath)) {
        console.error('❌ seedData.json not found at:', seedDataPath);
        process.exit(1);
    }

    const seedData = JSON.parse(fs.readFileSync(seedDataPath, 'utf8'));
    const { eventId, ratings } = seedData;

    console.log(`🍺 Seeding ${ratings.length} ratings for event: ${eventId}`);
    console.log('─'.repeat(50));

    let successCount = 0;
    let errorCount = 0;

    // Process ratings with a small delay to avoid throttling
    for (let i = 0; i < ratings.length; i++) {
        const rating = ratings[i];
        
        const item = {
            eventId,
            ratingId: generateUUID(),
            beerId: rating.beerId,
            rating: rating.rating,
            comment: rating.comment || '',
            createdAt: randomTimestamp(),
        };

        try {
            await docClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: item,
            }));
            
            successCount++;
            
            // Progress indicator every 10 ratings
            if ((i + 1) % 10 === 0 || i === ratings.length - 1) {
                const progress = Math.round(((i + 1) / ratings.length) * 100);
                process.stdout.write(`\r📊 Progress: ${i + 1}/${ratings.length} (${progress}%)`);
            }
        } catch (error) {
            errorCount++;
            console.error(`\n❌ Failed to insert rating ${i + 1}:`, error.message);
        }

        // Small delay to avoid throttling (10ms between writes)
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    console.log('\n' + '─'.repeat(50));
    console.log(`✅ Successfully inserted: ${successCount} ratings`);
    if (errorCount > 0) {
        console.log(`❌ Failed: ${errorCount} ratings`);
    }
    console.log('\n🎉 Seeding complete!');
    
    // Summary by beer
    console.log('\n📈 Ratings by beer:');
    const beerCounts = {};
    ratings.forEach(r => {
        beerCounts[r.beerId] = (beerCounts[r.beerId] || 0) + 1;
    });
    Object.entries(beerCounts).forEach(([beerId, count]) => {
        console.log(`   ${beerId}: ${count} ratings`);
    });
}

// Run the seeder
seedRatings().catch(console.error);
