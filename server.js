const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const sharp = require('sharp');

const app = express();
const port = 3000;

app.use(express.static('public'));
app.use(express.json());

const wss = new WebSocket.Server({ noServer: true });

function generateSafeFilename(url) {
  return crypto.createHash('md5').update(url).digest('hex') + '.jpg';
}

function initDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database('./sitemap_results.db', (err) => {
      if (err) {
        reject(err);
      } else {
        db.run(`CREATE TABLE IF NOT EXISTS crawls (
          id TEXT PRIMARY KEY,
          url TEXT,
          date TEXT
        )`, (err) => {
          if (err) {
            reject(err);
          } else {
            db.run(`CREATE TABLE IF NOT EXISTS pages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              crawl_id TEXT,
              url TEXT,
              title TEXT,
              description TEXT,
              keywords TEXT,
              h1 TEXT,
              canonical_url TEXT,
              og_title TEXT,
              og_description TEXT,
              og_image TEXT,
              twitter_card TEXT,
              twitter_title TEXT,
              twitter_description TEXT,
              twitter_image TEXT,
              screenshot_path TEXT,
              page_type TEXT DEFAULT 'cms',
              FOREIGN KEY (crawl_id) REFERENCES crawls (id)
            )`, (err) => {
              if (err) {
                reject(err);
              } else {
                resolve(db);
              }
            });
          }
        });
      }
    });
  });
}

async function parseSitemap(sitemapUrl) {
  console.log(`Parsing sitemap: ${sitemapUrl}`);
  const response = await axios.get(sitemapUrl);
  const parser = new xml2js.Parser();
  const result = await parser.parseStringPromise(response.data);
  console.log(`Sitemap parsed. Found ${result.urlset.url.length} URLs.`);
  return result.urlset.url.map(url => url.loc[0]);
}

async function captureScreenshot(url, outputPath) {
  console.log(`Capturing screenshot for: ${url}`);
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1600, height: 900 });
    await page.goto(url, { 
      waitUntil: 'networkidle0',
      timeout: 60000 // Increase timeout to 60 seconds
    });
    const screenshot = await page.screenshot({ fullPage: true });
    await sharp(screenshot)
      .resize({ width: 600 })
      .jpeg({ quality: 80 })
      .toFile(outputPath);
    console.log(`Screenshot captured and optimized for: ${url}`);
  } catch (error) {
    console.error(`Error capturing screenshot for ${url}:`, error.message);
    // Create a simple error image
    await page.setContent(`<html><body><h1>Error loading page</h1><p>${error.message}</p></body></html>`);
    const errorScreenshot = await page.screenshot();
    await sharp(errorScreenshot)
      .resize({ width: 600 })
      .jpeg({ quality: 80 })
      .toFile(outputPath);
  } finally {
    await browser.close();
  }
}

async function extractSEOData(url) {
  console.log(`Extracting SEO data for: ${url}`);
  try {
    const response = await axios.get(url, { timeout: 30000 });
    const $ = cheerio.load(response.data);
    
    const seoData = {
      url: url,
      title: $('title').text(),
      description: $('meta[name="description"]').attr('content'),
      keywords: $('meta[name="keywords"]').attr('content'),
      h1: $('h1').first().text(),
      canonicalUrl: $('link[rel="canonical"]').attr('href'),
      ogTitle: $('meta[property="og:title"]').attr('content'),
      ogDescription: $('meta[property="og:description"]').attr('content'),
      ogImage: $('meta[property="og:image"]').attr('content'),
      twitterCard: $('meta[name="twitter:card"]').attr('content'),
      twitterTitle: $('meta[name="twitter:title"]').attr('content'),
      twitterDescription: $('meta[name="twitter:description"]').attr('content'),
      twitterImage: $('meta[name="twitter:image"]').attr('content'),
    };

    console.log(`SEO data extracted for: ${url}`);
    return seoData;
  } catch (error) {
    console.error(`Error extracting SEO data for ${url}:`, error.message);
    return {
      url: url,
      title: 'Error extracting SEO data',
      description: error.message
    };
  }
}

async function processUrl(url, index, total, crawlId, retries = 3) {
  const filename = generateSafeFilename(url);
  const screenshotPath = path.join(__dirname, 'public', 'screenshots', crawlId, filename);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await captureScreenshot(url, screenshotPath);
      const seoData = await extractSEOData(url);
      return { 
        ...seoData, 
        screenshotPath: `/screenshots/${crawlId}/${filename}`,
        page_type: 'cms'  // Set default page_type
      };
    } catch (error) {
      console.error(`Error processing ${url} (attempt ${attempt}/${retries}):`, error.message);
      if (attempt === retries) {
        return {
          url,
          title: 'Error processing page',
          description: `Failed after ${retries} attempts: ${error.message}`,
          screenshotPath: `/screenshots/${crawlId}/${filename}`,
          page_type: 'cms'  // Set default page_type even for error cases
        };
      }
      // Wait for a short time before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

app.post('/process-sitemap', async (req, res) => {
  const { sitemapUrl, concurrency = 5 } = req.body;
  const crawlId = Date.now().toString();
  res.json({ message: 'Processing started', crawlId });

  const urls = await parseSitemap(sitemapUrl);
  const results = [];

  // Create necessary directories
  const screenshotsDir = path.join(__dirname, 'public', 'screenshots', crawlId);
  await fs.mkdir(screenshotsDir, { recursive: true });

  const db = await initDatabase();

  // Save crawl information
  await new Promise((resolve, reject) => {
    db.run('INSERT INTO crawls (id, url, date) VALUES (?, ?, ?)', [crawlId, sitemapUrl, new Date().toISOString()], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    console.log(`Processing batch ${i / concurrency + 1} of ${Math.ceil(urls.length / concurrency)}`);
    
    const batchResults = await Promise.all(
      batch.map(url => processUrl(url, i + batch.indexOf(url), urls.length, crawlId))
    );

    // Save batch results to SQLite
    for (const result of batchResults) {
      await new Promise((resolve, reject) => {
        db.run(`INSERT INTO pages (
          crawl_id, url, title, description, keywords, h1, canonical_url,
          og_title, og_description, og_image,
          twitter_card, twitter_title, twitter_description, twitter_image,
          screenshot_path, page_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crawlId, result.url, result.title, result.description, result.keywords,
          result.h1, result.canonicalUrl, result.ogTitle, result.ogDescription,
          result.ogImage, result.twitterCard, result.twitterTitle,
          result.twitterDescription, result.twitterImage, result.screenshotPath,
          result.page_type
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    results.push(...batchResults);

    // Send progress update
    const progress = Math.round(((i + batch.length) / urls.length) * 100);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'progress', progress }));
      }
    });
  }

  console.log('All URLs processed.');

  // Send completion message
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'complete',
        resultsUrl: `/results.html?crawlId=${crawlId}`
      }));
    }
  });

  db.close();
});

app.get('/results/:crawlId', async (req, res) => {
  const crawlId = req.params.crawlId;
  const db = await initDatabase();

  db.all('SELECT * FROM pages WHERE crawl_id = ?', [crawlId], (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Database error' });
    } else if (rows.length === 0) {
      res.status(404).json({ error: 'Crawl results not found' });
    } else {
      res.json(rows);
    }
    db.close();
  });
});

app.post('/update-page-type', async (req, res) => {
  const { crawlId, url, pageType } = req.body;
  const db = await initDatabase();

  db.run('UPDATE pages SET page_type = ? WHERE crawl_id = ? AND url = ?', [pageType, crawlId, url], (err) => {
    if (err) {
      res.status(500).json({ error: 'Database error' });
    } else {
      res.json({ success: true });
    }
    db.close();
  });
});

app.get('/previous-crawls', async (req, res) => {
  const db = await initDatabase();
  db.all('SELECT * FROM crawls ORDER BY date DESC LIMIT 10', (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Database error' });
    } else {
      res.json(rows);
    }
    db.close();
  });
});

app.post('/clear-database', async (req, res) => {
  const db = await initDatabase();
  db.serialize(() => {
    db.run('DELETE FROM pages');
    db.run('DELETE FROM crawls');
    db.run('VACUUM', (err) => {
      if (err) {
        res.status(500).json({ error: 'Database error' });
      } else {
        res.json({ success: true });
      }
      db.close();
    });
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/results', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'results.html'));
});

const server = app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, socket => {
    wss.emit('connection', socket, request);
  });
});