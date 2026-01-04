const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================
const DAYS_TO_SCRAPE = 2; // 1 = today only, 2 = today + tomorrow, 7 = full week
const OUTPUT_FILENAME = 'sessions-v2.json'; // Change to 'sessions.json' for production

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

const tmdbCache = new Map();

// Standardise time to format "H:MMam" or "H:MMpm" (e.g., "2:30pm", "10:00am")
function standardiseTime(timeStr) {
  if (!timeStr || timeStr.toLowerCase().includes('see website')) return timeStr;
  
  let hours, mins;
  
  // Try 12-hour format with space: "10:30 AM", "2:15 PM"
  const match12space = timeStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (match12space) {
    hours = parseInt(match12space[1], 10);
    mins = parseInt(match12space[2], 10);
    const period = match12space[3].toLowerCase();
    return `${hours}:${mins.toString().padStart(2, '0')}${period}`;
  }
  
  // Try 12-hour format without minutes: "2pm", "10am"
  const match12noMins = timeStr.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (match12noMins) {
    hours = parseInt(match12noMins[1], 10);
    const period = match12noMins[2].toLowerCase();
    return `${hours}:00${period}`;
  }
  
  // Try 12-hour format with minutes: "2:30pm", "10:00am"
  const match12 = timeStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (match12) {
    hours = parseInt(match12[1], 10);
    mins = parseInt(match12[2], 10);
    const period = match12[3].toLowerCase();
    return `${hours}:${mins.toString().padStart(2, '0')}${period}`;
  }
  
  // Try 24-hour format: "14:35", "9:00"
  const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    hours = parseInt(match24[1], 10);
    mins = parseInt(match24[2], 10);
    
    const period = hours >= 12 ? 'pm' : 'am';
    const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    return `${hour12}:${mins.toString().padStart(2, '0')}${period}`;
  }
  
  // Return original if no match
  return timeStr;
}

async function fetchTMDB(title) {
  const cacheKey = title.toLowerCase().trim();
  if (tmdbCache.has(cacheKey)) {
    return tmdbCache.get(cacheKey);
  }

  try {
    // Store original for ", The" check
    const originalTitle = title;
    
    let cleanTitle = title
      // Format markers (3D, IMAX, 4K, 2D, HFR, Dolby, etc.)
      .replace(/\b(3D|IMAX|4K|2K|2D|HFR|HDR|Dolby|Atmos)\b/gi, '')
      // Language/subtitle markers: (Hindi), (Telugu, Eng Sub), (English Subtitles), etc.
      .replace(/\([\w\s,'-]*(sub(titled|titles|s)?|dub(bed)?|eng|hindi|telugu|tamil|malayalam|kannada|korean|japanese|mandarin|cantonese|spanish|french|german|italian)[\w\s,'-]*\)/gi, '')
      // Anniversary/restoration: "- 25th Anniversary", "– 50th Anniversary 4K Restoration", etc.
      .replace(/[-–—]\s*\d+\s*(st|nd|rd|th)?\s*anniversary.*$/i, '')
      // Restoration/remaster anywhere at end
      .replace(/[-–—]?\s*(\d+K\s*)?(digital\s*)?(restoration|remaster(ed)?|re-?release).*$/i, '')
      // Special screenings: "- Preview", "– Special Event", "- Encore", etc.
      .replace(/[-–—]\s*(preview|special|encore|screening|event|limited).*$/i, '')
      // NT Live, Met Opera, etc.
      .replace(/\s*[-:]\s*(NT Live|Met Opera|National Theatre Live).*$/i, '')
      // Retro/classic markers
      .replace(/\s*[-–—]\s*(RETRO CLASSIX|CLASSIC|RETRO)$/i, '')
      // Year in parentheses at end: (1984), (2024 film)
      .replace(/\s*\(\d{4}(\s+film)?\)\s*$/i, '')
      // Brackets at end: [Restored], [Special Edition], etc.
      .replace(/\s*\[.*?\]\s*$/i, '')
      // "Housemaid, The" -> "Housemaid" (we'll add "The" back below)
      .replace(/,\s*The$/i, '')
      // Clean up extra whitespace and trailing punctuation
      .replace(/\s+/g, ' ')
      .replace(/[-–—:]\s*$/g, '')
      .trim();

    // If original title ends with ", The", move it to front
    if (originalTitle.match(/,\s*The$/i)) {
      cleanTitle = 'The ' + cleanTitle;
    }

    console.log(`  TMDB lookup: "${title}" -> "${cleanTitle}"`);

    const searchUrl = `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}`;
    const response = await fetch(searchUrl);
    const data = await response.json();

    if (data.results && data.results.length > 0) {
      // Take first result (best match) - don't prefer recent films as this breaks classic cinema listings
      const movie = data.results[0];
      
      // Fetch movie details to get runtime and trailers
      let runtime = null;
      let trailerUrl = null;
      try {
        const detailsUrl = `${TMDB_BASE}/movie/${movie.id}?api_key=${TMDB_API_KEY}&append_to_response=videos`;
        const detailsResponse = await fetch(detailsUrl);
        const details = await detailsResponse.json();
        runtime = details.runtime || null;
        
        // Find YouTube trailer
        if (details.videos && details.videos.results) {
          const trailer = details.videos.results.find(v => 
            v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')
          );
          if (trailer) {
            trailerUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
          }
        }
        
        await new Promise(r => setTimeout(r, 100)); // Small delay to avoid rate limiting
      } catch (e) {
        console.log(`  Could not fetch details for ${movie.title}`);
      }
      
      const result = {
        overview: movie.overview || null,
        posterPath: movie.poster_path ? `https://image.tmdb.org/t/p/w300${movie.poster_path}` : null,
        rating: movie.vote_average || null,
        year: movie.release_date ? movie.release_date.substring(0, 4) : null,
        runtime: runtime,
        trailerUrl: trailerUrl,
        tmdbId: movie.id
      };
      console.log(`  TMDB found: "${movie.title}" (${result.year})${runtime ? ` - ${runtime}min` : ''}${trailerUrl ? ' [trailer]' : ''}`);
      tmdbCache.set(cacheKey, result);
      return result;
    } else {
      console.log(`  TMDB: No results for "${cleanTitle}"`);
    }
  } catch (error) {
    console.error(`  TMDB lookup failed for "${title}":`, error.message);
  }

  const fallback = { overview: null, posterPath: null, rating: null, year: null, runtime: null, trailerUrl: null, tmdbId: null };
  tmdbCache.set(cacheKey, fallback);
  return fallback;
}

// ============================================================================
// DATE UTILITIES
// ============================================================================

// Get Melbourne date string for a given offset (0 = today, 1 = tomorrow)
function getMelbourneDateStr(dayOffset = 0) {
  const now = new Date();
  const melbourneTime = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
  melbourneTime.setDate(melbourneTime.getDate() + dayOffset);
  return melbourneTime.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Get formatted display date for a given offset
function getDisplayDate(dayOffset = 0) {
  const now = new Date();
  const melbourneTime = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
  melbourneTime.setDate(melbourneTime.getDate() + dayOffset);
  return melbourneTime.toLocaleDateString('en-AU', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Australia/Melbourne'
  });
}

// Get Melbourne Date object for a given offset
function getMelbourneDate(dayOffset = 0) {
  const now = new Date();
  const melbourneTime = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
  melbourneTime.setDate(melbourneTime.getDate() + dayOffset);
  return melbourneTime;
}

// ============================================================================
// SCRAPERS - Each accepts a targetDate parameter (YYYY-MM-DD)
// ============================================================================

async function scrapeACMI(page, targetDate) {
  console.log(`Scraping ACMI for ${targetDate}...`);
  const sessions = [];
  
  const apiUrl = `https://admin.acmi.net.au/api/v2/calendar/by-day/?date=${targetDate}`;
  const websiteUrl = `https://www.acmi.net.au/whats-on/?what=film&when_start=${targetDate}&when_end=${targetDate}`;
  
  console.log(`  API URL: ${apiUrl}`);
  
  try {
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    
    const json = await response.json();
    
    // Handle both array and object responses
    let data = json;
    if (!Array.isArray(json)) {
      // Try common wrapper keys
      data = json.occurrences || json.data || json.results || json.items || json.events || [];
      console.log(`  Response is object, keys: ${Object.keys(json).join(', ')}`);
    }
    
    if (!Array.isArray(data)) {
      console.log(`  Could not find array in response`);
      return { cinema: 'ACMI', url: websiteUrl, sessions };
    }
    
    console.log(`  Found ${data.length} items in API response`);
    
    // Debug: show first item structure
    if (data.length > 0) {
      const first = data[0];
      console.log(`  First item keys: ${Object.keys(first).join(', ')}`);
    }
    
    // Flatten nested structure - data may be [{date, occurrences: [...]}]
    let items = data;
    if (data.length > 0 && data[0].occurrences && Array.isArray(data[0].occurrences)) {
      // Only take occurrences from target date
      const targetData = data.find(d => d.date === targetDate);
      items = targetData?.occurrences || [];
      console.log(`  Found ${items.length} occurrences for ${targetDate}`);
    }
    
    // Group sessions by film title
    const filmMap = new Map();
    
    for (const item of items) {
      // Check for film type in various places
      const eventType = item.event_type?.name || item.event?.event_type?.name || item.type || '';
      
      // Skip non-films (but if type is unknown/empty, include it)
      if (eventType && eventType !== 'Film') continue;
      
      // Double-check the date matches target
      if (item.start_datetime) {
        const itemDate = item.start_datetime.split('T')[0];
        if (itemDate !== targetDate) continue;
      }
      
      const title = item.event?.title || item.title;
      if (!title) continue;
      
      // Extract time from start_datetime (e.g., "2025-12-30T16:00:00+11:00")
      // Parse directly from the string to avoid timezone conversion
      let time = 'See website';
      if (item.start_datetime) {
        const timeMatch = item.start_datetime.match(/T(\d{2}):(\d{2})/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10);
          const mins = parseInt(timeMatch[2], 10);
          const ampm = hours >= 12 ? 'pm' : 'am';
          const hour12 = hours % 12 || 12;
          time = mins > 0 ? `${hour12}:${mins.toString().padStart(2, '0')}${ampm}` : `${hour12}${ampm}`;
        }
      }
      
      // Build URL
      const filmUrl = item.event?.url 
        ? `https://www.acmi.net.au${item.event.url}` 
        : websiteUrl;
      
      if (filmMap.has(title)) {
        filmMap.get(title).times.push(time);
      } else {
        filmMap.set(title, {
          title,
          times: [time],
          url: filmUrl
        });
      }
    }
    
    filmMap.forEach(film => sessions.push(film));
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  ACMI scrape error:', error.message);
  }
  
  return { cinema: 'ACMI', url: websiteUrl, sessions };
}

// ============================================================================
// PLACEHOLDER SCRAPERS - To be migrated one by one
// ============================================================================

async function scrapeBrunswickPictureHouse(page, targetDate) {
  console.log(`Scraping Brunswick Picture House for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Brunswick Picture House', url: 'https://www.brunswickpicturehouse.com.au/now-showing/', sessions: [] };
}

async function scrapeEclipse(page, targetDate) {
  console.log(`Scraping Eclipse Cinema for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Eclipse Cinema', url: 'https://eclipse-cinema.com.au/session-time/', sessions: [] };
}

async function scrapeCinemaNova(page, targetDate) {
  console.log(`Scraping Cinema Nova for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Cinema Nova', url: 'https://www.cinemanova.com.au/films-today-after-0:00', sessions: [] };
}

async function scrapeLido(page, targetDate) {
  console.log(`Scraping Lido Cinemas for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Lido Cinemas', url: 'https://www.lidocinemas.com.au/now-showing', sessions: [] };
}

async function scrapeHoyts(page, targetDate) {
  console.log(`Scraping Hoyts Melbourne Central for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Hoyts Melbourne Central', url: 'https://www.hoyts.com.au/cinemas/melbourne-central', sessions: [], note: 'Lux sessions not listed' };
}

async function scrapeAstor(page, targetDate) {
  console.log(`Scraping Astor Theatre for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'The Astor Theatre', url: 'https://www.astortheatre.net.au/', sessions: [] };
}

async function scrapePalaceComo(page, targetDate) {
  console.log(`Scraping Palace Como for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Palace Como', url: 'https://www.palacecinemas.com.au/cinemas/palace-cinema-como', sessions: [] };
}

async function scrapePalaceKino(page, targetDate) {
  console.log(`Scraping Palace Kino for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Palace Kino', url: 'https://www.palacecinemas.com.au/cinemas/the-kino-melbourne', sessions: [] };
}

async function scrapePalaceWestgarth(page, targetDate) {
  console.log(`Scraping Palace Westgarth for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Palace Westgarth', url: 'https://www.palacecinemas.com.au/cinemas/palace-westgarth', sessions: [] };
}

async function scrapePentridge(page, targetDate) {
  console.log(`Scraping Pentridge Cinema for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Pentridge Cinema', url: 'https://www.palacecinemas.com.au/cinemas/pentridge-cinema', sessions: [] };
}

async function scrapeSunTheatre(page, targetDate) {
  console.log(`Scraping Sun Theatre for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Sun Theatre', url: 'https://suntheatre.com.au/now-playing/', sessions: [] };
}

async function scrapeImax(page, targetDate) {
  console.log(`Scraping Imax Melbourne for ${targetDate}... [NOT YET IMPLEMENTED]`);
  // TODO: Migrate from scraper.js
  return { cinema: 'Imax Melbourne', url: 'https://imaxmelbourne.com.au/session_times_and_tickets', sessions: [] };
}

// ============================================================================
// TMDB ENRICHMENT
// ============================================================================

async function enrichWithTMDB(cinemaData) {
  console.log(`Enriching ${cinemaData.cinema} with TMDB data...`);
  
  for (const session of cinemaData.sessions) {
    // Standardise all time formats to "H:MMam/pm"
    if (session.times && Array.isArray(session.times)) {
      session.times = session.times.map(t => standardiseTime(t));
    }
    if (session.premiumTimes && Array.isArray(session.premiumTimes)) {
      session.premiumTimes = session.premiumTimes.map(t => standardiseTime(t));
    }
    
    if (session.isDoubleFeature && (session.title.includes(' + ') || session.title.includes(' & '))) {
      const separator = session.title.includes(' + ') ? ' + ' : ' & ';
      const titles = session.title.split(separator);
      session.films = [];
      
      let totalRuntime = 0;
      for (const title of titles) {
        const tmdb = await fetchTMDB(title.trim());
        session.films.push({ title: title.trim(), ...tmdb });
        if (tmdb.runtime) totalRuntime += tmdb.runtime;
        await new Promise(r => setTimeout(r, 250));
      }
      
      if (session.films[0]?.posterPath) {
        session.posterPath = session.films[0].posterPath;
      }
      if (session.films[0]?.overview) {
        session.overview = session.films[0].overview;
      }
      // Sum runtime for double features
      session.runtime = totalRuntime > 0 ? totalRuntime : null;
      // Use first film's year and average rating
      session.year = session.films[0]?.year || null;
      if (session.films[0]?.rating && session.films[1]?.rating) {
        session.rating = (session.films[0].rating + session.films[1].rating) / 2;
      } else {
        session.rating = session.films[0]?.rating || session.films[1]?.rating || null;
      }
      // Use first film's trailer
      session.trailerUrl = session.films[0]?.trailerUrl || session.films[1]?.trailerUrl || null;
    } else {
      const tmdb = await fetchTMDB(session.title);
      session.overview = tmdb.overview;
      session.posterPath = tmdb.posterPath;
      session.rating = tmdb.rating;
      session.year = tmdb.year;
      session.runtime = tmdb.runtime;
      session.trailerUrl = tmdb.trailerUrl;
      await new Promise(r => setTimeout(r, 250));
    }
  }
  
  return cinemaData;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('Melbourne Cinema Scraper v2 (Multi-day)');
  console.log('='.repeat(60));
  console.log('Today:', getDisplayDate(0));
  console.log('Tomorrow:', getDisplayDate(1));
  console.log('='.repeat(60));
  
  if (!TMDB_API_KEY) {
    console.error('ERROR: TMDB_API_KEY environment variable not set!');
    process.exit(1);
  }
  console.log('TMDB API Key: Set ✓\n');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });
  
  const scrapers = [
    scrapeACMI,
    scrapeBrunswickPictureHouse,
    scrapeEclipse,
    scrapeCinemaNova,
    scrapeLido,
    scrapeHoyts,
    scrapeAstor,
    scrapePalaceComo,
    scrapePalaceKino,
    scrapePalaceWestgarth,
    scrapePentridge,
    scrapeImax,
    scrapeSunTheatre
  ];
  
  // Scrape for configured number of days
  const days = [];
  for (let dayOffset = 0; dayOffset < DAYS_TO_SCRAPE; dayOffset++) {
    const targetDate = getMelbourneDateStr(dayOffset);
    const displayDate = getDisplayDate(dayOffset);
    
    console.log('\n' + '='.repeat(60));
    console.log(`Scraping for: ${displayDate} (${targetDate})`);
    console.log('='.repeat(60));
    
    const results = [];
    for (const scraper of scrapers) {
      try {
        console.log('');
        const data = await scraper(page, targetDate);
        const enriched = await enrichWithTMDB(data);
        results.push(enriched);
      } catch (error) {
        console.error(`Scraper failed:`, error.message);
      }
    }
    
    days.push({
      date: displayDate,
      dateKey: targetDate,
      cinemas: results
    });
  }
  
  await browser.close();
  
  const output = {
    generatedAt: new Date().toISOString(),
    days: days
  };
  
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  fs.writeFileSync(
    path.join(dataDir, OUTPUT_FILENAME),
    JSON.stringify(output, null, 2)
  );
  
  console.log('\n' + '='.repeat(60));
  console.log('COMPLETE');
  console.log('='.repeat(60));
  for (const day of days) {
    console.log(`\n${day.date}:`);
    console.log(`  Total cinemas: ${day.cinemas.length}`);
    console.log(`  Total films: ${day.cinemas.reduce((sum, c) => sum + c.sessions.length, 0)}`);
    day.cinemas.forEach(c => console.log(`    ${c.cinema}: ${c.sessions.length} films`));
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
