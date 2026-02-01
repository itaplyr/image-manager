import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

const WORKER_URLS = (process.env.WORKER_URLS || 'http://localhost:3001').split(',');
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

async function processTradeAd(adId, tradeData) {
    try {
        console.log(`[Manager] Processing trade ad ${adId}`);

        const workerUrl = getNextWorker();
        console.log(`[Manager] Sending to worker: ${workerUrl}`);

        const response = await axios.post(`${workerUrl}/generate`, {
            tradeData: tradeData
        }, {
            responseType: 'arraybuffer',
            timeout: 60000
        });

        const imagePath = path.join(IMAGE_DIR, `${adId}.png`);
        fs.writeFileSync(imagePath, Buffer.from(response.data));

        console.log(`[Manager] Successfully saved image for trade ad ${adId}`);

    } catch (error) {
        console.error(`[Manager] Failed to process trade ad ${adId}:`, error.message);
    } finally {
        processingQueue.delete(adId);
    }
}

app.get('/health', async (req, res) => {
    let healthyWorkers = 0;

    await Promise.all(
        WORKER_URLS.map(async (workerUrl) => {
            try {
                await axios.get(`${workerUrl}/health`);
                healthyWorkers += 1;
            } catch (err) {
                console.error(`[Manager] Worker ${workerUrl} is unhealthy`);
            }
        })
    );

    res.json({
        status: 'healthy',
        manager: true,
        workers: WORKER_URLS.length,
        healthyWorkers,
        processing: processingQueue.size,
        cachedImages: fs.readdirSync(IMAGE_DIR).length
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