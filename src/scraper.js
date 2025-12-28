const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

// Cache for TMDB lookups to avoid duplicate requests
const tmdbCache = new Map();

async function fetchTMDB(title) {
  const cacheKey = title.toLowerCase().trim();
  if (tmdbCache.has(cacheKey)) {
    return tmdbCache.get(cacheKey);
  }

  try {
    let cleanTitle = title
      .replace(/\s*\(\d{4}\)\s*$/i, '')
      .replace(/\s*-\s*\d+\w*\s*anniversary\s*$/i, '')
      .replace(/\s*:\s*NT Live$/i, '')
      .replace(/\s*-\s*RETRO CLASSIX$/i, '')
      .replace(/\s*–\s*PREVIEW$/i, '')
      .replace(/\s*–\s*ACC presents…$/i, '')
      .trim();

    const searchUrl = `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}`;
    const response = await fetch(searchUrl);
    const data = await response.json();

    if (data.results && data.results.length > 0) {
      const movie = data.results[0];
      const result = {
        overview: movie.overview || 'No synopsis available.',
        posterPath: movie.poster_path ? `https://image.tmdb.org/t/p/w300${movie.poster_path}` : null,
        rating: movie.vote_average || null,
        year: movie.release_date ? movie.release_date.substring(0, 4) : null,
        tmdbId: movie.id
      };
      tmdbCache.set(cacheKey, result);
      return result;
    }
  } catch (error) {
    console.error(`TMDB lookup failed for "${title}":`, error.message);
  }

  const fallback = { overview: 'No synopsis available.', posterPath: null, rating: null, year: null, tmdbId: null };
  tmdbCache.set(cacheKey, fallback);
  return fallback;
}

async function scrapeACMI(page) {
  console.log('Scraping ACMI...');
  const sessions = [];
  
  try {
    await page.goto('https://www.acmi.net.au/whats-on/?what=film', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 10000 });
    
    const films = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('a[href*="/whats-on/"]').forEach(el => {
        const title = el.querySelector('h3, h2, .title')?.textContent?.trim();
        const timeEl = el.querySelector('.time, .date, p');
        const time = timeEl?.textContent?.trim();
        if (title && title.length > 2 && !title.includes('Exhibition') && !title.includes('Game Worlds')) {
          items.push({ title, time: time || 'See website for times', url: el.href });
        }
      });
      return items;
    });
    
    for (const film of films) {
      sessions.push({
        title: film.title,
        times: [film.time],
        url: film.url
      });
    }
  } catch (error) {
    console.error('ACMI scrape error:', error.message);
  }
  
  return { cinema: 'ACMI', url: 'https://www.acmi.net.au/whats-on/?what=film', sessions };
}

async function scrapeBrunswickPictureHouse(page) {
  console.log('Scraping Brunswick Picture House...');
  const sessions = [];
  
  try {
    await page.goto('https://www.brunswickpicturehouse.com.au/now-showing/', { waitUntil: 'networkidle2', timeout: 30000 });
    
    const films = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('a[href*="/movie/"]').forEach(el => {
        const title = el.textContent?.trim();
        const href = el.href;
        if (title && title.length > 2 && !href.includes('/checkout/')) {
          const parent = el.closest('div, li, tr');
          const times = [];
          if (parent) {
            parent.querySelectorAll('a[href*="/checkout/"]').forEach(timeEl => {
              const time = timeEl.textContent?.trim();
              if (time && /^\d{1,2}:\d{2}/.test(time)) {
                times.push(time);
              }
            });
          }
          if (times.length > 0) {
            items.push({ title, times, url: href });
          }
        }
      });
      return items;
    });
    
    const filmMap = new Map();
    for (const film of films) {
      if (filmMap.has(film.title)) {
        const existing = filmMap.get(film.title);
        film.times.forEach(t => {
          if (!existing.times.includes(t)) existing.times.push(t);
        });
      } else {
        filmMap.set(film.title, film);
      }
    }
    
    filmMap.forEach(film => sessions.push(film));
  } catch (error) {
    console.error('Brunswick Picture House scrape error:', error.message);
  }
  
  return { cinema: 'Brunswick Picture House', url: 'https://www.brunswickpicturehouse.com.au/now-showing/', sessions };
}

async function scrapeEclipse(page) {
  console.log('Scraping Eclipse Cinema...');
  const sessions = [];
  const today = new Date();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const todayPrefix = `${dayNames[today.getDay()]}-${String(today.getDate()).padStart(2, '0')}`;
  
  try {
    await page.goto('https://eclipse-cinema.com.au/session-time/', { waitUntil: 'networkidle2', timeout: 30000 });
    
    const films = await page.evaluate((todayPrefix) => {
      const items = [];
      document.querySelectorAll('.elementor-widget-container, article, .film-item, div').forEach(container => {
        const titleEl = container.querySelector('h2, h3, .title');
        const title = titleEl?.textContent?.trim();
        
        if (title && title.length > 3) {
          const text = container.textContent || '';
          const times = [];
          
          if (text.includes(todayPrefix)) {
            container.querySelectorAll('a[href*="veezi"]').forEach(timeEl => {
              const time = timeEl.textContent?.trim();
              if (time && /^\d{1,2}:\d{2}$/.test(time)) {
                times.push(time);
              }
            });
          }
          
          if (times.length > 0) {
            items.push({ title, times, url: 'https://eclipse-cinema.com.au/session-time/' });
          }
        }
      });
      return items;
    }, todayPrefix);
    
    const filmMap = new Map();
    for (const film of films) {
      const cleanTitle = film.title.replace(/\s+/g, ' ').trim();
      if (!filmMap.has(cleanTitle)) {
        filmMap.set(cleanTitle, { ...film, title: cleanTitle });
      }
    }
    
    filmMap.forEach(film => sessions.push(film));
  } catch (error) {
    console.error('Eclipse Cinema scrape error:', error.message);
  }
  
  return { cinema: 'Eclipse Cinema', url: 'https://eclipse-cinema.com.au/session-time/', sessions };
}

async function scrapeCinemaNova(page) {
  console.log('Scraping Cinema Nova...');
  const sessions = [];
  
  try {
    await page.goto('https://www.cinemanova.com.au/films-now-showing', { waitUntil: 'networkidle2', timeout: 30000 });
    
    const filmLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href*="/films/"]').forEach(el => {
        const href = el.href;
        const img = el.querySelector('img');
        if (href && !links.some(l => l.url === href)) {
          const title = img?.alt || el.textContent?.trim() || href.split('/films/')[1]?.replace(/-/g, ' ');
          if (title) {
            links.push({ url: href, title });
          }
        }
      });
      return links;
    });
    
    for (const film of filmLinks.slice(0, 20)) {
      const title = film.title
        .split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        .replace(/\s+/g, ' ').trim();
      
      sessions.push({
        title,
        times: ['See website for times'],
        url: film.url
      });
    }
  } catch (error) {
    console.error('Cinema Nova scrape error:', error.message);
  }
  
  return { cinema: 'Cinema Nova', url: 'https://www.cinemanova.com.au/', sessions };
}

async function scrapeLido(page) {
  console.log('Scraping Lido Cinemas...');
  const sessions = [];
  
  try {
    await page.goto('https://www.lidocinemas.com.au/now-showing', { waitUntil: 'networkidle2', timeout: 30000 });
    
    const films = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('a[href*="/movies/"]').forEach(el => {
        const title = el.textContent?.trim() || el.querySelector('img')?.alt;
        const href = el.href;
        if (title && title.length > 2 && !items.some(i => i.title === title)) {
          items.push({ title, url: href });
        }
      });
      return items;
    });
    
    for (const film of films) {
      sessions.push({
        title: film.title,
        times: ['See website for times'],
        url: film.url
      });
    }
  } catch (error) {
    console.error('Lido Cinemas scrape error:', error.message);
  }
  
  return { cinema: 'Lido Cinemas', url: 'https://www.lidocinemas.com.au/now-showing', sessions };
}

async function scrapeHoyts(page) {
  console.log('Scraping Hoyts Melbourne Central...');
  const sessions = [];
  
  try {
    await page.goto('https://www.hoyts.com.au/cinemas/melbourne-central', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    const films = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('a[href*="/movies/"]').forEach(el => {
        const title = el.textContent?.trim() || el.getAttribute('title') || el.querySelector('img')?.alt;
        const href = el.href;
        if (title && title.length > 2) {
          items.push({ title, url: href });
        }
      });
      return items;
    });
    
    const seen = new Set();
    for (const film of films) {
      if (!seen.has(film.title)) {
        seen.add(film.title);
        sessions.push({
          title: film.title,
          times: ['See website for times'],
          url: film.url
        });
      }
    }
  } catch (error) {
    console.error('Hoyts scrape error:', error.message);
  }
  
  return { cinema: 'Hoyts Melbourne Central', url: 'https://www.hoyts.com.au/cinemas/melbourne-central', sessions };
}

async function scrapeAstor(page) {
  console.log('Scraping Astor Theatre...');
  const sessions = [];
  
  try {
    await page.goto('https://www.palacecinemas.com.au/cinemas/the-astor-theatre/', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    const films = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('.session, .movie-item, a[href*="/movies/"]').forEach(el => {
        const title = el.textContent?.trim() || el.getAttribute('title');
        if (title && title.length > 2) {
          items.push({ title, url: el.href || 'https://www.astortheatre.net.au/' });
        }
      });
      return items;
    });
    
    const seen = new Set();
    for (const film of films) {
      if (!seen.has(film.title) && film.title.length > 2) {
        seen.add(film.title);
        sessions.push({
          title: film.title,
          times: ['See website for times'],
          url: film.url,
          isDoubleFeature: false
        });
      }
    }
    
    if (sessions.length === 0) {
      await page.goto('https://www.astortheatre.net.au/', { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForTimeout(3000);
      
      const altFilms = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('a, .session, .film').forEach(el => {
          const text = el.textContent?.trim();
          if (text && text.length > 5 && text.length < 100) {
            items.push({ title: text, url: 'https://www.astortheatre.net.au/' });
          }
        });
        return items.slice(0, 10);
      });
      
      for (const film of altFilms) {
        sessions.push({
          title: film.title,
          times: ['7:30 PM (typical)'],
          url: film.url,
          isDoubleFeature: film.title.includes('+') || film.title.includes(' & ') || film.title.includes(' / ')
        });
      }
    }
  } catch (error) {
    console.error('Astor Theatre scrape error:', error.message);
  }
  
  return { 
    cinema: 'The Astor Theatre', 
    url: 'https://www.astortheatre.net.au/', 
    sessions,
    note: 'Famous for double features - check website for full program'
  };
}

async function enrichWithTMDB(cinemaData) {
  console.log(`Enriching ${cinemaData.cinema} with TMDB data...`);
  
  for (const session of cinemaData.sessions) {
    if (session.isDoubleFeature || session.title.includes(' + ') || session.title.includes(' & ')) {
      const titles = session.title.split(/\s*[+&\/]\s*/);
      session.films = [];
      for (const title of titles) {
        const tmdb = await fetchTMDB(title.trim());
        session.films.push({
          title: title.trim(),
          ...tmdb
        });
      }
    } else {
      const tmdb = await fetchTMDB(session.title);
      session.overview = tmdb.overview;
      session.posterPath = tmdb.posterPath;
      session.rating = tmdb.rating;
      session.year = tmdb.year;
    }
    
    await new Promise(r => setTimeout(r, 100));
  }
  
  return cinemaData;
}

async function main() {
  console.log('Starting Melbourne Cinema Scraper...');
  console.log('Date:', new Date().toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });
  
  const results = [];
  
  const scrapers = [
    scrapeACMI,
    scrapeBrunswickPictureHouse,
    scrapeEclipse,
    scrapeCinemaNova,
    scrapeLido,
    scrapeHoyts,
    scrapeAstor
  ];
  
  for (const scraper of scrapers) {
    try {
      const data = await scraper(page);
      const enriched = await enrichWithTMDB(data);
      results.push(enriched);
    } catch (error) {
      console.error(`Scraper failed:`, error.message);
    }
  }
  
  await browser.close();
  
  const output = {
    generatedAt: new Date().toISOString(),
    date: new Date().toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    cinemas: results
  };
  
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  fs.writeFileSync(
    path.join(dataDir, 'sessions.json'),
    JSON.stringify(output, null, 2)
  );
  
  console.log('Done! Sessions saved to data/sessions.json');
  console.log(`Total cinemas: ${results.length}`);
  console.log(`Total sessions: ${results.reduce((sum, c) => sum + c.sessions.length, 0)}`);
}

main().catch(console.error);
