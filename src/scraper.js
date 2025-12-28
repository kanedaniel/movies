const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

const tmdbCache = new Map();

async function fetchTMDB(title) {
  const cacheKey = title.toLowerCase().trim();
  if (tmdbCache.has(cacheKey)) {
    return tmdbCache.get(cacheKey);
  }

  try {
    // Clean up title for better matching
    let cleanTitle = title
      .replace(/\s*\(\d{4}\)\s*$/i, '')           // Remove (1984)
      .replace(/\s*\(\d{4}\s+film\)\s*$/i, '')    // Remove (1984 film)
      .replace(/\s*-\s*\d+\w*\s*anniversary\s*$/i, '') // Remove - 50th Anniversary
      .replace(/\s*:\s*NT Live$/i, '')            // Remove : NT Live
      .replace(/\s*-\s*RETRO CLASSIX$/i, '')      // Remove - RETRO CLASSIX
      .replace(/\s*[–-]\s*PREVIEW$/i, '')         // Remove – PREVIEW
      .replace(/\s*[–-]\s*ACC presents.*$/i, '')  // Remove ACC presents
      .replace(/\s*\d+K\s*Restoration$/i, '')     // Remove 4K Restoration
      .replace(/\s*\(Restoration\)$/i, '')        // Remove (Restoration)
      .replace(/\s*\[.*?\]$/i, '')                // Remove [anything] at end
      .trim();

    console.log(`  TMDB lookup: "${title}" -> "${cleanTitle}"`);

    const searchUrl = `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}`;
    const response = await fetch(searchUrl);
    const data = await response.json();

    if (data.results && data.results.length > 0) {
      const movie = data.results[0];
      const result = {
        overview: movie.overview || null,
        posterPath: movie.poster_path ? `https://image.tmdb.org/t/p/w300${movie.poster_path}` : null,
        rating: movie.vote_average || null,
        year: movie.release_date ? movie.release_date.substring(0, 4) : null,
        tmdbId: movie.id
      };
      console.log(`  TMDB found: "${movie.title}" (${result.year})`);
      tmdbCache.set(cacheKey, result);
      return result;
    } else {
      console.log(`  TMDB: No results for "${cleanTitle}"`);
    }
  } catch (error) {
    console.error(`  TMDB lookup failed for "${title}":`, error.message);
  }

  const fallback = { overview: null, posterPath: null, rating: null, year: null, tmdbId: null };
  tmdbCache.set(cacheKey, fallback);
  return fallback;
}

async function scrapeACMI(page) {
  console.log('Scraping ACMI...');
  const sessions = [];
  
  // Build URL with today's date
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
  const url = `https://www.acmi.net.au/whats-on/?what=film&when_start=${dateStr}&when_end=${dateStr}`;
  
  console.log(`  URL: ${url}`);
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const films = await page.evaluate(() => {
      const items = [];
      // Look for event cards with film info
      document.querySelectorAll('a[href*="/whats-on/"]').forEach(el => {
        const href = el.href;
        // Skip if it's just the main whats-on link or contains filters
        if (href === 'https://www.acmi.net.au/whats-on/' || href.includes('?')) return;
        
        const titleEl = el.querySelector('h2, h3, h4, [class*="title"]');
        const title = titleEl?.textContent?.trim();
        
        // Look for time info
        const timeEl = el.querySelector('[class*="time"], [class*="date"], time');
        const time = timeEl?.textContent?.trim();
        
        if (title && title.length > 2) {
          // Filter out non-film content
          const skipWords = ['exhibition', 'game worlds', 'story of the moving image', 'talk', 'workshop'];
          const titleLower = title.toLowerCase();
          if (skipWords.some(word => titleLower.includes(word))) return;
          
          items.push({ 
            title, 
            time: time || 'See website for times', 
            url: href 
          });
        }
      });
      return items;
    });
    
    // Dedupe by title
    const seen = new Set();
    for (const film of films) {
      if (!seen.has(film.title)) {
        seen.add(film.title);
        sessions.push({
          title: film.title,
          times: [film.time],
          url: film.url
        });
      }
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  ACMI scrape error:', error.message);
  }
  
  return { cinema: 'ACMI', url: url, sessions };
}

async function scrapeBrunswickPictureHouse(page) {
  console.log('Scraping Brunswick Picture House...');
  const sessions = [];
  const url = 'https://www.brunswickpicturehouse.com.au/now-showing/';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    // Get the page content and parse the showtimes section
    const films = await page.evaluate(() => {
      const items = [];
      const text = document.body.innerText;
      
      // Look for the Showtimes section - Brunswick has a simple format:
      // Movie Title | Time
      const lines = text.split('\n');
      let inShowtimes = false;
      
      for (const line of lines) {
        if (line.includes('Showtimes')) {
          inShowtimes = true;
          continue;
        }
        if (inShowtimes && line.includes('Marketing Signup')) {
          break;
        }
        
        // Match pattern: has a time like "12:20PM" or "8:35PM"
        const timeMatch = line.match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
        if (timeMatch && inShowtimes) {
          // The title is everything before the time indicator
          const parts = line.split('|');
          if (parts.length >= 1) {
            const title = parts[0].trim();
            const time = timeMatch[1];
            if (title && title.length > 2 && !title.match(/^\d/)) {
              items.push({ title, time });
            }
          }
        }
      }
      
      // Also try to get URLs from links
      const movieLinks = {};
      document.querySelectorAll('a[href*="/movie/"]').forEach(el => {
        const title = el.textContent?.trim();
        const href = el.href;
        if (title && href && !href.includes('checkout')) {
          movieLinks[title] = href;
        }
      });
      
      // Merge URLs with items
      return items.map(item => ({
        ...item,
        url: movieLinks[item.title] || 'https://www.brunswickpicturehouse.com.au/now-showing/'
      }));
    });
    
    // Group by title and collect times
    const filmMap = new Map();
    for (const film of films) {
      if (filmMap.has(film.title)) {
        filmMap.get(film.title).times.push(film.time);
      } else {
        filmMap.set(film.title, {
          title: film.title,
          times: [film.time],
          url: film.url
        });
      }
    }
    
    filmMap.forEach(film => sessions.push(film));
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Brunswick Picture House scrape error:', error.message);
  }
  
  return { cinema: 'Brunswick Picture House', url, sessions };
}

async function scrapeEclipse(page) {
  console.log('Scraping Eclipse Cinema...');
  const sessions = [];
  const url = 'https://eclipse-cinema.com.au/session-time/';
  
  const today = new Date();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayStr = `${dayNames[today.getDay()]}-${String(today.getDate()).padStart(2, '0')}-${months[today.getMonth()]}`;
  
  console.log(`  Looking for date: ${todayStr}`);
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const films = await page.evaluate((todayStr) => {
      const items = [];
      
      // Eclipse lists films with dates like "Mon-29-Dec"
      // Find all film blocks
      const filmBlocks = document.querySelectorAll('h2, h3');
      
      filmBlocks.forEach(heading => {
        const title = heading.textContent?.trim();
        if (!title || title.length < 3) return;
        
        // Skip navigation/header items
        const skipWords = ['by date', 'by film', 'session time', 'eclipse cinema'];
        if (skipWords.some(w => title.toLowerCase().includes(w))) return;
        
        // Get the parent container
        let container = heading.closest('div, article, section');
        if (!container) container = heading.parentElement;
        
        // Check if today's date appears in this container
        const containerText = container?.textContent || '';
        if (!containerText.includes(todayStr)) return;
        
        // Find time links (Veezi booking links)
        const times = [];
        const timeLinks = container.querySelectorAll('a[href*="veezi"]');
        timeLinks.forEach(link => {
          const time = link.textContent?.trim();
          if (time && /^\d{1,2}:\d{2}$/.test(time)) {
            times.push(time);
          }
        });
        
        if (times.length > 0) {
          items.push({ title, times, url: 'https://eclipse-cinema.com.au/session-time/' });
        }
      });
      
      return items;
    }, todayStr);
    
    // Dedupe
    const seen = new Set();
    for (const film of films) {
      if (!seen.has(film.title)) {
        seen.add(film.title);
        sessions.push(film);
      }
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Eclipse Cinema scrape error:', error.message);
  }
  
  return { cinema: 'Eclipse Cinema', url, sessions };
}

async function scrapeCinemaNova(page) {
  console.log('Scraping Cinema Nova...');
  const sessions = [];
  const url = 'https://www.cinemanova.com.au/films-today-after-0:00';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const films = await page.evaluate(() => {
      const items = [];
      
      // Find film entries - Nova shows films with session times
      document.querySelectorAll('a[href*="/films/"]').forEach(el => {
        const href = el.href;
        if (!href || href.includes('coming-soon') || href.includes('now-showing')) return;
        
        // Get title from link text or image alt
        let title = el.textContent?.trim();
        const img = el.querySelector('img');
        if ((!title || title.length < 2) && img) {
          title = img.alt?.trim();
        }
        
        // Extract film slug for cleaner title if needed
        if (!title || title.length < 2) {
          const match = href.match(/\/films\/([^\/\?]+)/);
          if (match) {
            title = match[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          }
        }
        
        if (title && title.length > 2) {
          // Look for times near this element
          const parent = el.closest('div, li, article');
          const times = [];
          if (parent) {
            const timeMatches = parent.textContent?.match(/\d{1,2}:\d{2}\s*[AP]?M?/gi) || [];
            timeMatches.forEach(t => {
              if (!times.includes(t)) times.push(t);
            });
          }
          
          items.push({
            title,
            times: times.length > 0 ? times : ['See website for times'],
            url: href
          });
        }
      });
      
      return items;
    });
    
    // Dedupe by URL (more reliable than title)
    const seen = new Set();
    for (const film of films) {
      if (!seen.has(film.url)) {
        seen.add(film.url);
        sessions.push(film);
      }
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Cinema Nova scrape error:', error.message);
  }
  
  return { cinema: 'Cinema Nova', url, sessions };
}

async function scrapeLido(page) {
  console.log('Scraping Lido Cinemas...');
  const sessions = [];
  const url = 'https://www.lidocinemas.com.au/now-showing';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const films = await page.evaluate(() => {
      const items = [];
      
      document.querySelectorAll('a[href*="/movies/"]').forEach(el => {
        const href = el.href;
        let title = el.textContent?.trim();
        
        // Also check for title in nested elements
        if (!title || title.length < 2) {
          const titleEl = el.querySelector('h2, h3, h4, [class*="title"]');
          title = titleEl?.textContent?.trim();
        }
        
        // Check image alt
        if (!title || title.length < 2) {
          const img = el.querySelector('img');
          title = img?.alt?.trim();
        }
        
        if (title && title.length > 2 && href) {
          // Skip duplicates and non-movie links
          if (!items.some(i => i.url === href)) {
            items.push({
              title,
              url: href
            });
          }
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
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Lido Cinemas scrape error:', error.message);
  }
  
  return { cinema: 'Lido Cinemas', url, sessions };
}

async function scrapeHoyts(page) {
  console.log('Scraping Hoyts Melbourne Central...');
  const sessions = [];
  const url = 'https://www.hoyts.com.au/cinemas/melbourne-central';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const films = await page.evaluate(() => {
      const items = [];
      
      // Filter words that indicate non-movie content
      const skipWords = ['find out more', 'learn more', 'book now', 'sign up', 'join', 'menu', 'experiences', 'food', 'gift'];
      
      document.querySelectorAll('a[href*="/movies/"]').forEach(el => {
        const href = el.href;
        let title = el.textContent?.trim();
        
        // Check for title in nested elements
        if (!title || title.length < 2) {
          const titleEl = el.querySelector('h2, h3, h4, [class*="title"]');
          title = titleEl?.textContent?.trim();
        }
        
        // Check image alt
        if (!title || title.length < 2) {
          const img = el.querySelector('img');
          title = img?.alt?.trim();
        }
        
        if (title && title.length > 2) {
          const titleLower = title.toLowerCase();
          
          // Skip non-movie links
          if (skipWords.some(w => titleLower.includes(w))) return;
          
          // Skip if title is too short or just numbers
          if (title.length < 3 || /^\d+$/.test(title)) return;
          
          if (!items.some(i => i.title === title)) {
            items.push({
              title,
              url: href
            });
          }
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
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Hoyts scrape error:', error.message);
  }
  
  return { cinema: 'Hoyts Melbourne Central', url, sessions };
}

async function scrapeAstor(page) {
  console.log('Scraping Astor Theatre...');
  const sessions = [];
  const url = 'https://www.astortheatre.net.au/';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(5000); // Astor site can be slow
    
    const films = await page.evaluate(() => {
      const items = [];
      
      // Skip words - navigation, social, etc.
      const skipWords = [
        'now showing', 'calendar', 'session times', 'prices', 'about', 
        'private hire', 'friends', 'blog', 'contact', 'map', 'parking',
        'twitter', 'facebook', 'instagram', 'the astor theatre',
        'phone', 'email', 'menu', 'home', 'search', 'ical', 'subscribe'
      ];
      
      // Look for session/film information
      // Astor typically shows double features with format "Film 1 + Film 2" or lists them
      const allText = document.body.innerText;
      const lines = allText.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length < 3 || trimmed.length > 150) continue;
        
        const lineLower = trimmed.toLowerCase();
        
        // Skip navigation/footer items
        if (skipWords.some(w => lineLower === w || lineLower.startsWith(w + ' ') || lineLower.includes(w))) continue;
        
        // Skip lines that are clearly not film titles
        if (lineLower.includes('@') || lineLower.includes('http') || lineLower.includes('.com') || lineLower.includes('.au')) continue;
        if (/^\d+$/.test(trimmed)) continue; // Just numbers
        if (trimmed.startsWith('(') && trimmed.endsWith(')')) continue;
        
        // Look for film-like patterns:
        // - Contains a year in parentheses like (1954)
        // - Contains "+" indicating double feature
        const hasYear = /\(\d{4}\)/.test(trimmed);
        const isDoubleFeature = trimmed.includes(' + ') || (trimmed.includes(' & ') && trimmed.length > 10);
        
        if (hasYear || isDoubleFeature) {
          items.push({
            title: trimmed,
            isDoubleFeature
          });
        }
      }
      
      return items;
    });
    
    // Dedupe and clean up
    const seen = new Set();
    for (const film of films) {
      // Clean up title
      let title = film.title.replace(/\s+/g, ' ').trim();
      
      if (!seen.has(title) && title.length > 3) {
        seen.add(title);
        sessions.push({
          title,
          times: ['See website for times'],
          url,
          isDoubleFeature: film.isDoubleFeature
        });
      }
    }
    
    console.log(`  Found ${sessions.length} films`);
    return { 
      cinema: 'The Astor Theatre', 
      url, 
      sessions,
      note: 'Famous for double features - check website for full program'
    };
  } catch (error) {
    console.error('  Astor Theatre scrape error:', error.message);
    return { 
      cinema: 'The Astor Theatre', 
      url, 
      sessions: [],
      note: 'Famous for double features - check website for full program'
    };
  }
}

async function enrichWithTMDB(cinemaData) {
  console.log(`Enriching ${cinemaData.cinema} with TMDB data...`);
  
  for (const session of cinemaData.sessions) {
    // Handle double features
    if (session.isDoubleFeature && (session.title.includes(' + ') || session.title.includes(' & '))) {
      const separator = session.title.includes(' + ') ? ' + ' : ' & ';
      const titles = session.title.split(separator);
      session.films = [];
      
      for (const title of titles) {
        const tmdb = await fetchTMDB(title.trim());
        session.films.push({
          title: title.trim(),
          ...tmdb
        });
        await new Promise(r => setTimeout(r, 250));
      }
      
      // Use first film's poster for the card
      if (session.films[0]?.posterPath) {
        session.posterPath = session.films[0].posterPath;
      }
      // Combine overviews
      const overviews = session.films.map(f => f.overview).filter(Boolean);
      if (overviews.length > 0) {
        session.overview = overviews[0]; // Just use first film's overview
      }
    } else {
      const tmdb = await fetchTMDB(session.title);
      session.overview = tmdb.overview;
      session.posterPath = tmdb.posterPath;
      session.rating = tmdb.rating;
      session.year = tmdb.year;
      await new Promise(r => setTimeout(r, 250));
    }
  }
  
  return cinemaData;
}

async function main() {
  console.log('='.repeat(60));
  console.log('Melbourne Cinema Scraper');
  console.log('='.repeat(60));
  console.log('Date:', new Date().toLocaleDateString('en-AU', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Australia/Melbourne'
  }));
  console.log('Time:', new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Melbourne' }));
  console.log('='.repeat(60));
  
  if (!TMDB_API_KEY) {
    console.error('ERROR: TMDB_API_KEY environment variable not set!');
    process.exit(1);
  }
  console.log('TMDB API Key: Set ✓');
  console.log('');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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
      console.log('');
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
    date: new Date().toLocaleDateString('en-AU', { 
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'Australia/Melbourne'
    }),
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
  
  console.log('');
  console.log('='.repeat(60));
  console.log('COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total cinemas: ${results.length}`);
  console.log(`Total sessions: ${results.reduce((sum, c) => sum + c.sessions.length, 0)}`);
  
  // Summary
  for (const cinema of results) {
    console.log(`  ${cinema.cinema}: ${cinema.sessions.length} films`);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
