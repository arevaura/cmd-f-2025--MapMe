const dotenv = require('dotenv');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const https = require('https');
const fs = require('fs');

const axios = require('axios');

const RateLimit = require('express-rate-limit');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
// Middleware
app.use(cors({
    origin: '*', // Be careful with this in production
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Increase JSON body size limit to 10MB for image uploads
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Add headers for geolocation permission and CORS
app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'geolocation=(self)');
    res.setHeader('Feature-Policy', 'geolocation *');
    // Add additional security headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    next();
});

// Serve static files except index.html (which we'll serve with the API key injected)
app.use(express.static(path.join(__dirname), {
    index: false // Don't serve index.html automatically
}));

// Serve index.html with API key injected
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    fs.readFile(indexPath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading index.html:', err);
            return res.status(500).send('Error loading application');
        }
        
        // Replace the API key placeholder with the actual key from environment variables
        const html = data.replace('GOOGLE_MAPS_API_KEY_PLACEHOLDER', process.env.GOOGLE_MAPS_API_KEY);
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    });
});

// Google Maps API configuration


// Set up rate limiter: maximum of 100 requests per 15 minutes
const limiter = RateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // max 100 requests per windowMs
});

// Define constants first
const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';  // Listen on all network interfaces

// Create HTTP server instead of HTTPS
const server = app;

// Keep in-memory storage as fallback
const inMemoryJournalEntries = [];
let nextEntryId = 1;
let useMongoDb = false;

const journalEntrySchema = new mongoose.Schema({
    title: String,
    content: String,
    user: {
        id: String,
        name: String,
        email: String
    },
    location: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            type: [Number],  // [longitude, latitude]
            required: true
        },
        address: String,
        details: {
            formatted_address: String,
            place_id: String,
            location_type: String,
            types: [String]
        },
        notes: String,
        photo: String, // Base64 encoded image
        emoji: String  // Emoji character for the marker
    },
    path: [{
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            type: [Number],
            required: true
        },
        timestamp: {
            type: Date,
            default: Date.now
        }
    }],
    date: {
        type: Date,
        default: Date.now
    }
});

journalEntrySchema.index({ location: '2dsphere' });

// Create a model
const JournalEntry = mongoose.model('JournalEntry', journalEntrySchema);

// API Routes
app.post('/api/journal', async (req, res) => {
    try {
        const { title, content, location, path, user } = req.body;
        
        // Validate required fields
        if (!location || !location.coordinates) {
            return res.status(400).json({ 
                error: 'Location coordinates are required' 
            });
        }

        // Validate coordinates format
        if (!Array.isArray(location.coordinates) || location.coordinates.length !== 2) {
            return res.status(400).json({ 
                error: 'Location coordinates must be an array of [longitude, latitude]' 
            });
        }

        if (useMongoDb) {
            // MongoDB version
            const newEntry = new JournalEntry({
                title: title || `Route ${new Date().toLocaleString()}`,
                content: content || `Route with ${path ? path.length : 0} points`,
                user: {
                    id: user?.id || 'anonymous',
                    name: user?.name || 'Anonymous User',
                    email: user?.email || ''
                },
                location: {
                    type: 'Point',
                    coordinates: location.coordinates,
                    address: location.address || '',
                    details: location.details || {},
                    notes: location.notes || '',
                    photo: location.photo || '',
                    emoji: location.emoji || ''
                },
                path: Array.isArray(path) ? path.map(point => ({
                    type: 'Point',
                    coordinates: point.coordinates,
                    timestamp: point.timestamp || new Date()
                })) : []
            });
            
            const savedEntry = await newEntry.save();
            console.log('Successfully saved journal entry to MongoDB:', savedEntry._id);
            res.status(201).json(savedEntry);
        } else {
            // In-memory version
            const newEntry = {
                _id: nextEntryId++,
                title: title || `Route ${new Date().toLocaleString()}`,
                content: content || `Route with ${path ? path.length : 0} points`,
                user: {
                    id: user?.id || 'anonymous',
                    name: user?.name || 'Anonymous User',
                    email: user?.email || ''
                },
                location: {
                    type: 'Point',
                    coordinates: location.coordinates,
                    address: location.address || '',
                    details: location.details || {},
                    notes: location.notes || '',
                    photo: location.photo || '',
                    emoji: location.emoji || ''
                },
                path: Array.isArray(path) ? path.map(point => ({
                    type: 'Point',
                    coordinates: point.coordinates,
                    timestamp: point.timestamp || new Date()
                })) : [],
                date: new Date()
            };
            
            // Save to in-memory storage
            inMemoryJournalEntries.push(newEntry);
            console.log('Successfully saved journal entry to memory:', newEntry._id);
            res.status(201).json(newEntry);
        }
    } catch (error) {
        console.error('Error saving journal entry:', error);
        res.status(500).json({ 
            error: 'Failed to save journal entry',
            details: error.message 
        });
    }
});

// Update path for an existing journal entry
app.post('/api/journal/:id/location', limiter, async (req, res) => {
    try {
        const { latitude, longitude } = req.body;
        const entry = await JournalEntry.findById(req.params.id);
        
        if (!entry) {
            return res.status(404).json({ message: 'Entry not found' });
        }

        entry.path.push({
            type: 'Point',
            coordinates: [longitude, latitude]
        });

        await entry.save();
        res.json(entry);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get journal entry with its path
app.get('/api/journal/:id', limiter, async (req, res) => {
    try {
        const entry = await JournalEntry.findById(req.params.id);
        if (!entry) {
            return res.status(404).json({ message: 'Entry not found' });
        }
        res.json(entry);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all journal entries
app.get('/api/journal', async (req, res) => {
    try {
        if (useMongoDb) {
            const entries = await JournalEntry.find();
            res.json(entries);
        } else {
            res.json(inMemoryJournalEntries);
        }
    } catch (error) {
        console.error('Error fetching journal entries:', error);
        res.status(500).json({ error: 'Failed to fetch entries' });
    }
});

// Get journal entry by ID
app.get('/api/journal/:id', async (req, res) => {
    try {
        if (useMongoDb) {
            const entry = await JournalEntry.findById(req.params.id);
            if (!entry) {
                return res.status(404).json({ message: 'Entry not found' });
            }
            res.json(entry);
        } else {
            const id = parseInt(req.params.id);
            const entry = inMemoryJournalEntries.find(e => e._id === id);
            
            if (!entry) {
                return res.status(404).json({ message: 'Entry not found' });
            }
            
            res.json(entry);
        }
    } catch (error) {
        console.error('Error fetching journal entry:', error);
        res.status(500).json({ error: 'Failed to fetch entry' });
    }
});

// Get journal entries by user
app.get('/api/journal/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        console.log(`Fetching journal entries for user: ${userId}`);
        
        if (useMongoDb) {
            console.log('Using MongoDB to fetch entries');
            try {
                // Validate MongoDB connection
                if (mongoose.connection.readyState !== 1) {
                    console.error('MongoDB connection is not ready');
                    throw new Error('Database connection is not ready');
                }
                
                // Check if JournalEntry model exists
                if (!JournalEntry) {
                    console.error('JournalEntry model is not defined');
                    throw new Error('Database model is not defined');
                }
                
                // Log the query we're about to execute
                console.log(`Executing query: JournalEntry.find({ 'user.id': '${userId}' })`);
                
                // Execute the query with a timeout
                const entries = await JournalEntry.find({ 'user.id': userId }).maxTimeMS(5000);
                
                console.log(`Found ${entries.length} entries for user ${userId}`);
                console.log('Sample entry (first one):', entries.length > 0 ? JSON.stringify(entries[0]) : 'No entries');
                
                return res.json(entries);
            } catch (dbError) {
                console.error('Database error:', dbError);
                return res.status(500).json({ error: `Database error: ${dbError.message}` });
            }
        } else {
            console.log('Using in-memory storage to fetch entries');
            console.log('In-memory entries:', inMemoryJournalEntries.length);
            
            const entries = inMemoryJournalEntries.filter(entry => entry.user && entry.user.id === userId);
            console.log(`Found ${entries.length} entries for user ${userId}`);
            
            return res.json(entries);
        }
    } catch (error) {
        console.error('Error fetching user journal entries:', error);
        return res.status(500).json({ error: `Failed to fetch user entries: ${error.message}` });
    }
});

// Delete journal entry by ID
app.delete('/api/journal/:id', async (req, res) => {
    try {
        const entryId = req.params.id;
        console.log(`Deleting journal entry with ID: ${entryId}`);
        
        if (useMongoDb) {
            console.log('Using MongoDB to delete entry');
            try {
                // Validate MongoDB connection
                if (mongoose.connection.readyState !== 1) {
                    console.error('MongoDB connection is not ready');
                    throw new Error('Database connection is not ready');
                }
                
                // Check if JournalEntry model exists
                if (!JournalEntry) {
                    console.error('JournalEntry model is not defined');
                    throw new Error('Database model is not defined');
                }
                
                // Find and delete the entry
                const deletedEntry = await JournalEntry.findByIdAndDelete(entryId);
                
                if (!deletedEntry) {
                    return res.status(404).json({ error: 'Entry not found' });
                }
                
                console.log(`Successfully deleted entry with ID: ${entryId}`);
                return res.json({ message: 'Entry deleted successfully', deletedEntry });
            } catch (dbError) {
                console.error('Database error:', dbError);
                return res.status(500).json({ error: `Database error: ${dbError.message}` });
            }
        } else {
            console.log('Using in-memory storage to delete entry');
            
            // Find the index of the entry to delete
            const entryIndex = inMemoryJournalEntries.findIndex(entry => entry._id.toString() === entryId);
            
            if (entryIndex === -1) {
                return res.status(404).json({ error: 'Entry not found' });
            }
            
            // Remove the entry from the array
            const deletedEntry = inMemoryJournalEntries.splice(entryIndex, 1)[0];
            
            console.log(`Successfully deleted entry with ID: ${entryId}`);
            return res.json({ message: 'Entry deleted successfully', deletedEntry });
        }
    } catch (error) {
        console.error('Error deleting journal entry:', error);
        return res.status(500).json({ error: `Failed to delete entry: ${error.message}` });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Something went wrong!' });
});

// Handle POST request to create a journal entry

// Handle GET request to retrieve all journal entries

// Testing endpoint

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
    socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
    family: 4 // Use IPv4, skip trying IPv6
})
.then(() => {
    console.log('Connected to MongoDB');
    useMongoDb = true;
    // Start server after successful MongoDB connection
    startServer();
})
.catch((error) => {
    console.error('MongoDB connection error:', error);
    console.log('Falling back to in-memory storage');
    // Start server anyway, using in-memory storage
    startServer();
});

// Function to start the server
function startServer() {
    server.listen(PORT, HOST, () => {
        console.log(`Server is running on http://${HOST}:${PORT}`);
        console.log('To access from other devices on your network:');
        console.log('1. Make sure your phone is connected to the same WiFi');
        console.log('2. Use one of these URLs on your phone:');
        console.log(`   http://localhost:${PORT}`);
        console.log(`   http://127.0.0.1:${PORT}`);
        console.log(`   http://<your-computer-ip>:${PORT}`);
        console.log(`Using ${useMongoDb ? 'MongoDB' : 'in-memory'} storage for data`);
    });
}


// ----------------------------
// // TODO: Google OAuth2 API configuration for server handling token exchange

// const { OAuth2Client } = require('google-auth-library');

// const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'http://localhost:3000/auth');

// app.post('/auth/google', async (req, res) => {
//     const { credential } = req.body;
//     try {
//       const ticket = await client.verifyIdToken({
//         idToken: credential,
//         audience: process.env.GOOGLE_CLIENT_ID,
//       });
//       const payload = ticket.getPayload();
//       const userid = payload['sub'];
  
//       const { tokens } = await client.getToken(credential);
//       res.json(tokens);
//     } catch (error) {
//       console.error('Error exchanging token:', error);
//       res.status(500).json({ error: 'Failed to exchange token' });
//     }
//   });