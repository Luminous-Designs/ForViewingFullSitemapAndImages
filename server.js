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
const { Client } = require('@notionhq/client');
require('dotenv').config();


const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

const wss = new WebSocket.Server({ noServer: true });

// Initialize Notion client
const notion = new Client({ auth: process.env.NOTION_API_KEY });

function generateSafeFilename(url) {
  return crypto.createHash('md5').update(url).digest('hex') + '.jpg';
}

function initDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database('./sitemap_results.db', (err) => {
      if (err) {
        reject(err);
      } else {
        db.serialize(() => {
          db.run(`CREATE TABLE IF NOT EXISTS crawls (
            id TEXT PRIMARY KEY,
            url TEXT,
            date TEXT
          )`, (err) => {
            if (err) reject(err);
          });

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
            if (err) reject(err);
            else resolve(db);
          });
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
        page_type: 'cms'
      };
    } catch (error) {
      console.error(`Error processing ${url} (attempt ${attempt}/${retries}):`, error.message);
      if (attempt === retries) {
        return {
          url,
          title: 'Error processing page',
          description: `Failed after ${retries} attempts: ${error.message}`,
          screenshotPath: `/screenshots/${crawlId}/${filename}`,
          page_type: 'cms'
        };
      }
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

  const screenshotsDir = path.join(__dirname, 'public', 'screenshots', crawlId);
  await fs.mkdir(screenshotsDir, { recursive: true });

  const db = await initDatabase();

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

    const progress = Math.round(((i + batch.length) / urls.length) * 100);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'progress', progress }));
      }
    });
  }

  console.log('All URLs processed.');

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

app.post('/create-notion-database', async (req, res) => {
  const { crawlId } = req.body;
  const db = await initDatabase();

  const githubUsername = 'Luminous-Designs';
  const githubRepo = 'ForViewingFullSitemapAndImages';
  const githubBranch = 'main';

  try {
    const crawlData = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM crawls WHERE id = ?', [crawlId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const pagesData = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM pages WHERE crawl_id = ?', [crawlId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    const response = await notion.databases.create({
      parent: { type: 'page_id', page_id: process.env.NOTION_PARENT_PAGE_ID },
      title: [
        {
          type: 'text',
          text: {
            content: `Website Crawl - ${new URL(crawlData.url).hostname} - ${new Date(crawlData.date).toLocaleString()}`,
          },
        },
      ],
      properties: {
        'Page Name': { title: {} },
        'URL': { url: {} },
        'SEO Description': { rich_text: {} },
        'SEO Keywords': { rich_text: {} },
        'H1': { rich_text: {} },
        'Canonical URL': { url: {} },
        'OG Title': { rich_text: {} },
        'OG Description': { rich_text: {} },
        'OG Image': { url: {} },
        'Twitter Card': { rich_text: {} },
        'Twitter Title': { rich_text: {} },
        'Twitter Description': { rich_text: {} },
        'Twitter Image': { url: {} },
        'Page Type': { select: { options: [{ name: 'Custom' }, { name: 'CMS' }] } },
        'Screenshot': { files: {} },
      },
    });

    for (const page of pagesData) {
      const githubImageUrl = `https://raw.githubusercontent.com/${githubUsername}/${githubRepo}/${githubBranch}/public${page.screenshot_path}`;

      await notion.pages.create({
        parent: { database_id: response.id },
        properties: {
          'Page Name': { title: [{ text: { content: page.title || 'Untitled' } }] },
          'URL': { url: page.url },
          'SEO Description': { rich_text: [{ text: { content: page.description || '' } }] },
          'SEO Keywords': { rich_text: [{ text: { content: page.keywords || '' } }] },
          'H1': { rich_text: [{ text: { content: page.h1 || '' } }] },
          'Canonical URL': { url: page.canonical_url || null },
          'OG Title': { rich_text: [{ text: { content: page.og_title || '' } }] },
          'OG Description': { rich_text: [{ text: { content: page.og_description || '' } }] },
          'OG Image': { url: page.og_image || null },
          'Twitter Card': { rich_text: [{ text: { content: page.twitter_card || '' } }] },
          'Twitter Title': { rich_text: [{ text: { content: page.twitter_title || '' } }] },
          'Twitter Description': { rich_text: [{ text: { content: page.twitter_description || '' } }] },
          'Twitter Image': { url: page.twitter_image || null },
          'Page Type': { select: { name: page.page_type === 'custom' ? 'Custom' : 'CMS' } },
          'Screenshot': { files: [{ type: 'external', name: 'Screenshot', external: { url: githubImageUrl } }] },
        },
      });
    }

    res.json({ success: true, databaseId: response.id });
  } catch (error) {
    console.error('Error creating Notion database:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    db.close();
  }
});

const fetch = require('node-fetch').default;

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

app.post('/send-to-trello', async (req, res) => {
    const { crawlId } = req.body;
    const db = await initDatabase();

    const githubUsername = 'Luminous-Designs';
    const githubRepo = 'ForViewingFullSitemapAndImages';
    const githubBranch = 'main';

    try {
        const crawlData = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM crawls WHERE id = ?', [crawlId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        const pagesData = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM pages WHERE crawl_id = ?', [crawlId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        // Create a new board for this crawl
        const boardResponse = await fetch(`https://api.trello.com/1/boards?name=Sitemap Crawl ${crawlId}&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`, {
            method: 'POST'
        });
        const boardData = await boardResponse.json();
        const boardId = boardData.id;

        // Create a list in the new board
        const listResponse = await fetch(`https://api.trello.com/1/lists?name=Pages&idBoard=${boardId}&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`, {
            method: 'POST'
        });
        const listData = await listResponse.json();
        const listId = listData.id;

        for (const page of pagesData) {
            const githubImageUrl = `https://raw.githubusercontent.com/${githubUsername}/${githubRepo}/${githubBranch}/public${page.screenshot_path}`;

            const cardResponse = await fetch(`https://api.trello.com/1/cards?idList=${listId}&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: page.title || 'Untitled',
                    desc: `
URL: ${page.url}
SEO Description: ${page.description || ''}
SEO Keywords: ${page.keywords || ''}
H1: ${page.h1 || ''}
Canonical URL: ${page.canonical_url || ''}
OG Title: ${page.og_title || ''}
OG Description: ${page.og_description || ''}
OG Image: ${page.og_image || ''}
Twitter Card: ${page.twitter_card || ''}
Twitter Title: ${page.twitter_title || ''}
Twitter Description: ${page.twitter_description || ''}
Twitter Image: ${page.twitter_image || ''}
Page Type: ${page.page_type === 'custom' ? 'Custom' : 'CMS'}
                    `,
                    urlSource: githubImageUrl
                })
            });

            await cardResponse.json();
        }

        res.json({ success: true, boardUrl: boardData.url });
    } catch (error) {
        console.error('Error sending data to Trello:', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        db.close();
    }
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