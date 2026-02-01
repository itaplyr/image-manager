import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

const WORKERS_FILE = path.join(process.cwd(), 'workers.json');

// Load workers from file or env
function loadWorkers() {
    try {
        if (fs.existsSync(WORKERS_FILE)) {
            const data = fs.readFileSync(WORKERS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading workers file:', error);
    }
    return (process.env.WORKER_URLS || 'http://localhost:3001').split(',');
}

// Save workers to file
function saveWorkers(workers) {
    try {
        fs.writeFileSync(WORKERS_FILE, JSON.stringify(workers, null, 2));
    } catch (error) {
        console.error('Error saving workers file:', error);
    }
}

let WORKER_URLS = loadWorkers();
const POLL_INTERVAL = 60 * 1000;
const IMAGE_DIR = path.join(process.cwd(), 'images');
const CACHE_DURATION = 10 * 60 * 1000;

if (!fs.existsSync(IMAGE_DIR)) {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
}
let lastPolledTradeAds = new Set();
let workerIndex = 0;
let processingQueue = new Set();

function getNextWorker() {
    const worker = WORKER_URLS[workerIndex % WORKER_URLS.length];
    workerIndex++;
    return worker;
}

function cleanupOldImages() {
    try {
        const files = fs.readdirSync(IMAGE_DIR);
        const now = Date.now();

        for (const file of files) {
            const filePath = path.join(IMAGE_DIR, file);
            const stats = fs.statSync(filePath);

            if (now - stats.mtime.getTime() > CACHE_DURATION) {
                fs.unlinkSync(filePath);
                console.log(`[Manager] Cleaned up old image: ${file}`);
            }
        }
    } catch (error) {
        console.error('[Manager] Error during cleanup:', error.message);
    }
}

async function pollTradeAds() {
    try {
        console.log('[Manager] Polling for new trade ads...');
        const response = await axios.get('https://api.rolimons.com/tradeads/v1/getrecentads', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (response.data && response.data.ads) {
            const currentAds = new Set(response.data.ads.map(ad => ad[0]));

            const newAds = [...currentAds].filter(id => !lastPolledTradeAds.has(id));

            if (newAds.length > 0) {
                console.log(`[Manager] Found ${newAds.length} new trade ads: ${newAds.join(', ')}`);
                for (const adId of newAds) {
                    if (!processingQueue.has(adId)) {
                        processingQueue.add(adId);
                        processTradeAd(adId, response.data.trade_ads.find(ad => ad[0] === adId));
                    }
                }
            }

            lastPolledTradeAds = currentAds;
        }

    } catch (error) {
        console.error('[Manager] Error polling trade ads:', error.message);
    }
}

async function processTradeAd(adId, tradeData, attempts = 0, triedWorkers = new Set()) {
    const MAX_ATTEMPTS = WORKER_URLS.length;

    if (attempts >= MAX_ATTEMPTS) {
        console.error(`[Manager] All workers overloaded or failed for trade ad ${adId}`);
        processingQueue.delete(adId);
        return;
    }

    const workerUrl = getNextWorker();

    // Prevent retrying the same worker
    if (triedWorkers.has(workerUrl)) {
        return processTradeAd(adId, tradeData, attempts + 1, triedWorkers);
    }

    triedWorkers.add(workerUrl);

    try {
        console.log(`[Manager] Processing trade ad ${adId} on ${workerUrl}`);

        const response = await axios.post(
            `${workerUrl}/generate`,
            { tradeData },
            {
                responseType: 'arraybuffer',
                timeout: 60000,
                validateStatus: () => true // allow 367 to be handled manually
            }
        );

        // Worker says "I'm overloaded"
        if (response.status === 367) {
            console.warn(`[Manager] ${workerUrl} overloaded (>400MB RAM), trying next worker`);
            return processTradeAd(adId, tradeData, attempts + 1, triedWorkers);
        }

        // Any non-success status other than 367
        if (response.status !== 200) {
            console.error(
                `[Manager] Worker ${workerUrl} failed with status ${response.status}`
            );
            return processTradeAd(adId, tradeData, attempts + 1, triedWorkers);
        }

        // Success
        const imagePath = path.join(IMAGE_DIR, `${adId}.png`);
        fs.writeFileSync(imagePath, Buffer.from(response.data));

        console.log(`[Manager] Successfully saved image for trade ad ${adId}`);

    } catch (error) {
        console.error(
            `[Manager] Error processing trade ad ${adId} on ${workerUrl}:`,
            error.message
        );
        return processTradeAd(adId, tradeData, attempts + 1, triedWorkers);
    } finally {
        // Only remove if we're done (success OR all attempts exhausted)
        if (attempts + 1 >= MAX_ATTEMPTS) {
            processingQueue.delete(adId);
        }
    }
}


app.get('/health', async (req, res) => {
    let healthyWorkers = 0;
    let totalWorkersRam = 0;

    await Promise.all(
        WORKER_URLS.map(async (workerUrl) => {
            try {
                const response = await axios.get(`${workerUrl}/health`);
                healthyWorkers += 1;
                if (response.data.ramUsage) {
                    totalWorkersRam += response.data.ramUsage;
                }
            } catch (err) {
                console.error(`[Manager] Worker ${workerUrl} is unhealthy`);
            }
        })
    );

    const managerRam = Math.round(process.memoryUsage().rss / 1024 / 1024); // MB
    const totalSystemRam = Math.round(os.totalmem() / 1024 / 1024); // MB
    const ramUsage = totalWorkersRam; // Total worker RAM
    const workersUsage = ramUsage / (healthyWorkers * 512) * 100

    res.json({
        status: 'healthy',
        manager: true,
        workers: WORKER_URLS.length,
        healthyWorkers,
        processing: processingQueue.size,
        cachedImages: fs.readdirSync(IMAGE_DIR).length,
        managerRam,
        totalSystemRam,
        ramUsage,
        workersUsage
    });
});

app.get('/image/:tradeAdId', (req, res) => {
    const { tradeAdId } = req.params;
    const imagePath = path.join(IMAGE_DIR, `${tradeAdId}.png`);

    if (fs.existsSync(imagePath)) {
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(imagePath);
    } else {
        if (!processingQueue.has(tradeAdId) && !lastPolledTradeAds.has(tradeAdId)) {
            console.log(`[Manager] Image not found for ${tradeAdId}, will check on next poll`);
        }
        res.status(404).json({ error: 'Image not found' });
    }
});

app.post('/generate/:tradeAdId', async (req, res) => {
    const { tradeAdId } = req.params;

    try {
        const response = await axios.get('https://api.rolimons.com/tradeads/v1/getrecentads', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const tradeData = response.data.trade_ads.find(ad => ad[0] == tradeAdId);
        if (!tradeData) {
            return res.status(404).json({ error: 'Trade ad not found' });
        }

        await processTradeAd(tradeAdId, tradeData);
        res.json({ success: true, message: 'Image generated' });

    } catch (error) {
        console.error(`[Manager] Error in force generate for ${tradeAdId}:`, error.message);
        res.status(500).json({ error: 'Failed to generate image' });
    }
});

app.get('/settings', (req, res) => {
    res.json({ workers: WORKER_URLS });
});

app.post('/settings', (req, res) => {
    const { workers } = req.body;
    if (Array.isArray(workers)) {
        WORKER_URLS = workers;
        saveWorkers(workers);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Invalid workers array' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

setInterval(pollTradeAds, POLL_INTERVAL);

setInterval(cleanupOldImages, 60 * 60 * 1000);

pollTradeAds();

app.listen(PORT, () => {
    console.log(`Image Manager running on port ${PORT}`);
    console.log(`Connected to ${WORKER_URLS.length} workers: ${WORKER_URLS.join(', ')}`);
});

export default app;