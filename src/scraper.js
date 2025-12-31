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

// Helper to get Melbourne date string
function getMelbourneDateStr() {
  const now = new Date();
  // Convert to Melbourne time
  const melbourneTime = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
  return melbourneTime.toISOString().split('T')[0];
}

async function scrapeACMI(page) {
  console.log('Scraping ACMI...');
  const sessions = [];
  
  const dateStr = getMelbourneDateStr();
  const apiUrl = `https://admin.acmi.net.au/api/v2/calendar/by-day/?date=${dateStr}`;
  const websiteUrl = `https://www.acmi.net.au/whats-on/?what=film&when_start=${dateStr}&when_end=${dateStr}`;
  
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
      // Only take occurrences from today's date
      const todayData = data.find(d => d.date === dateStr);
      items = todayData?.occurrences || [];
      console.log(`  Found ${items.length} occurrences for ${dateStr}`);
    }
    
    // Group sessions by film title
    const filmMap = new Map();
    
    for (const item of items) {
      // Check for film type in various places
      const eventType = item.event_type?.name || item.event?.event_type?.name || item.type || '';
      
      // Skip non-films (but if type is unknown/empty, include it)
      if (eventType && eventType !== 'Film') continue;
      
      // Double-check the date matches today
      if (item.start_datetime) {
        const itemDate = item.start_datetime.split('T')[0];
        if (itemDate !== dateStr) continue;
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

async function scrapeBrunswickPictureHouse(page) {
  console.log('Scraping Brunswick Picture House...');
  const sessions = [];
  const url = 'https://www.brunswickpicturehouse.com.au/now-showing/';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    // Wait for Vue.js to render the content
    await page.waitForTimeout(5000);
    
    // Wait for movie cards to appear
    try {
      await page.waitForSelector('.poster-title, div.poster-title', { timeout: 10000 });
      console.log('  Movie cards found');
    } catch (e) {
      console.log('  Waiting for movie cards timed out, trying anyway...');
    }
    
    const films = await page.evaluate(() => {
      const items = [];
      const seenTitles = new Set();
      
      // Find the span with class "text-primary" containing "Today"
      const todaySpan = document.querySelector('span.text-primary');
      if (!todaySpan || !todaySpan.textContent?.toLowerCase().includes('today')) {
        console.log('Could not find Today span');
        return items;
      }
      
      // Go up to the header div (text-h6), then get its next sibling (poster-list)
      const headerDiv = todaySpan.closest('.text-h6, [class*="text-h6"]');
      if (!headerDiv) {
        console.log('Could not find header div');
        return items;
      }
      
      const todayContainer = headerDiv.nextElementSibling;
      if (!todayContainer || !todayContainer.classList.contains('poster-list')) {
        console.log('Could not find poster-list after header');
        return items;
      }
      
      // Now get all movie cards from just this container
      const movieCards = todayContainer.querySelectorAll('[class*="showing-status-now-playing"]');
      
      movieCards.forEach(card => {
        const titleEl = card.querySelector('.poster-title');
        const title = titleEl?.textContent?.trim();
        
        if (!title || seenTitles.has(title)) return;
        
        const times = [];
        card.querySelectorAll('button.showing').forEach(btn => {
          const timeEl = btn.querySelector('div.text-primary, div[style*="color: var(--q-primary)"]');
          const time = timeEl?.textContent?.trim();
          if (time && /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(time)) {
            times.push(time);
          }
        });
        
        if (times.length > 0) {
          seenTitles.add(title);
          items.push({
            title,
            times,
            url: 'https://www.brunswickpicturehouse.com.au/now-showing/'
          });
        }
      });
      
      return items;
    });
    
    for (const film of films) {
      sessions.push(film);
    }
    
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
  
  // Build today's date string in Eclipse format: "Mon-29-Dec"
  const now = new Date();
  const melbourneTime = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayStr = `${dayNames[melbourneTime.getDay()]}-${String(melbourneTime.getDate()).padStart(2, '0')}-${months[melbourneTime.getMonth()]}`;
  
  console.log(`  Looking for date pattern: ${todayStr}`);
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForTimeout(5000);
    
    const films = await page.evaluate((todayStr) => {
      const items = [];
      
      // Get all film entries and check each one for today's date
      // Can't rely on class selector due to broken HTML from apostrophes
      const filmEntries = document.querySelectorAll('.veezi-filter-entry');
      
      filmEntries.forEach(entry => {
        // Check if this entry has today's date - look in class list or dropdown
        const classStr = entry.className || '';
        const hasDateInClass = classStr.toLowerCase().includes(todayStr.toLowerCase());
        
        // Also check the date dropdown for today
        const dateSelect = entry.querySelector('select.veezi-file-date-select');
        const hasDateInDropdown = dateSelect && 
          Array.from(dateSelect.options).some(opt => opt.value === todayStr);
        
        if (!hasDateInClass && !hasDateInDropdown) return;
        
        // Get title from the filter-film-title div
        const titleEl = entry.querySelector('.veezi-filter-film-title');
        const title = titleEl?.textContent?.trim();
        
        if (!title) return;
        
        // Get times for today - check the class of each time link
        const times = [];
        entry.querySelectorAll('a.veezi-film-purchase').forEach(link => {
          // Check if this time is for today (has the date in its class)
          const linkClass = link.className || '';
          if (linkClass.includes(todayStr)) {
            const timeEl = link.querySelector('p');
            const time = timeEl?.textContent?.trim();
            if (time && /^\d{1,2}:\d{2}$/.test(time)) {
              times.push(time);
            }
          }
        });
        
        if (times.length > 0) {
          items.push({ title, times });
        }
      });
      
      return items;
    }, todayStr);
    
    const seen = new Set();
    for (const film of films) {
      if (!seen.has(film.title)) {
        seen.add(film.title);
        sessions.push({
          ...film,
          url
        });
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
    
    // Cinema Nova has a table with time | title format
    const films = await page.evaluate(() => {
      const items = [];
      const filmMap = new Map();
      
      // Find the session table - it has rows with time and title
      const rows = document.querySelectorAll('tr, table tr');
      
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          // First cell is time link, second is title
          const timeCell = cells[0];
          const titleCell = cells[1];
          
          const timeLink = timeCell.querySelector('a');
          const time = timeLink?.textContent?.trim() || timeCell.textContent?.trim();
          const title = titleCell.textContent?.trim();
          
          // Validate time format
          if (time && title && /^\d{1,2}:\d{2}$/.test(time)) {
            if (filmMap.has(title)) {
              filmMap.get(title).times.push(time);
            } else {
              filmMap.set(title, {
                title,
                times: [time],
                url: `https://www.cinemanova.com.au/films/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
              });
            }
          }
        }
      });
      
      // Convert map to array
      filmMap.forEach(film => items.push(film));
      return items;
    });
    
    for (const film of films) {
      sessions.push(film);
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
    // Wait for JavaScript to load session times
    await page.waitForTimeout(5000);
    
    // Wait for the Sessions elements to appear
    try {
      await page.waitForSelector('.Sessions, ul.Sessions, .sessions-link', { timeout: 10000 });
      console.log('  Session elements found');
    } catch (e) {
      console.log('  Waiting for sessions timed out, trying anyway...');
    }
    
    const films = await page.evaluate(() => {
      const filmMap = new Map();
      
      // Target the session links directly - they have data-name attribute with movie title
      // Structure: a.sessions-link[data-name="Movie Title"] > span.Time
      document.querySelectorAll('a.sessions-link, a[class*="sessions-link"]').forEach(link => {
        const movieName = link.getAttribute('data-name');
        const timeSpan = link.querySelector('span.Time, .Time');
        const time = timeSpan?.textContent?.trim();
        
        if (movieName && time) {
          if (filmMap.has(movieName)) {
            filmMap.get(movieName).times.push(time);
          } else {
            filmMap.set(movieName, {
              title: movieName,
              times: [time],
              url: link.href || 'https://www.lidocinemas.com.au/now-showing'
            });
          }
        }
      });
      
      // Also try getting films from the movie cards in case sessions approach fails
      if (filmMap.size === 0) {
        document.querySelectorAll('.Markup.Movie, div[class*="Movie"]').forEach(card => {
          const titleEl = card.querySelector('a[href*="/movies/"]');
          const title = titleEl?.textContent?.trim() || card.getAttribute('data-name');
          
          if (title) {
            const times = [];
            card.querySelectorAll('.Time, span[class*="Time"]').forEach(t => {
              const time = t.textContent?.trim();
              if (time && /\d{1,2}:\d{2}/.test(time)) {
                times.push(time);
              }
            });
            
            if (!filmMap.has(title)) {
              filmMap.set(title, {
                title,
                times: times.length > 0 ? times : ['See website'],
                url: titleEl?.href || 'https://www.lidocinemas.com.au/now-showing'
              });
            }
          }
        });
      }
      
      // Convert map to array
      const result = [];
      filmMap.forEach(film => result.push(film));
      return result;
    });
    
    for (const film of films) {
      sessions.push(film);
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
    // Wait for JavaScript to load the movie list
    await page.waitForTimeout(5000);
    
    // Wait for the movies list to appear
    try {
      await page.waitForSelector('.movies-list__item, li.movies-list__item', { timeout: 10000 });
      console.log('  Movies list found');
    } catch (e) {
      console.log('  Waiting for movies list timed out, trying anyway...');
    }
    
    const films = await page.evaluate(() => {
      const items = [];
      
      // Each movie is in li.movies-list__item
      document.querySelectorAll('li.movies-list__item').forEach(movieItem => {
        // Get movie title from h2.movies-list__heading > a.movies-list__link
        const titleLink = movieItem.querySelector('h2.movies-list__heading a.movies-list__link');
        const title = titleLink?.textContent?.trim();
        const movieUrl = titleLink?.href;
        
        if (!title) return;
        
        // Get session times, but skip LUX sessions
        const times = [];
        movieItem.querySelectorAll('.sessions__list .sessions__item').forEach(sessionItem => {
          // Check if this session has a LUX tag
          const luxTag = sessionItem.querySelector('.session__tag--lux');
          if (luxTag) return; // Skip LUX sessions
          
          const timeEl = sessionItem.querySelector('.session__time');
          const time = timeEl?.textContent?.trim();
          if (time) {
            times.push(time);
          }
        });
        
        // Only add if there are non-LUX sessions
        if (times.length > 0) {
          items.push({
            title,
            times,
            url: movieUrl || 'https://www.hoyts.com.au/cinemas/melbourne-central'
          });
        }
      });
      
      return items;
    });
    
    for (const film of films) {
      sessions.push(film);
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Hoyts scrape error:', error.message);
  }
  
  return { cinema: 'Hoyts Melbourne Central', url, sessions, note: 'Lux sessions not listed' };
}

async function scrapeAstor(page) {
  console.log('Scraping Astor Theatre...');
  const sessions = [];
  const url = 'https://www.astortheatre.net.au/';
  
  try {
    // Helper function with timeout
    const fetchWithTimeout = async (fetchUrl, options = {}, timeoutMs = 30000) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(fetchUrl, { ...options, signal: controller.signal });
        return response;
      } finally {
        clearTimeout(timeout);
      }
    };
    
    // First, get the initial page content
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await response.text();
    console.log(`  Homepage HTML length: ${html.length}`);
    
    // Also try the AJAX endpoint for more sessions
    let ajaxHtml = '';
    try {
      const ajaxResponse = await fetchWithTimeout('https://www.astortheatre.net.au/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: 'action=get_frontpage_sessions&offset=0'
      });
      ajaxHtml = await ajaxResponse.text();
      console.log(`  AJAX HTML length: ${ajaxHtml.length}`);
    } catch (e) {
      console.log(`  AJAX fetch failed, using homepage only: ${e.message}`);
    }
    
    // Combine both HTML sources
    const combinedHtml = html + ajaxHtml;
    
    // Debug: check for movie_preview
    const previewCount = (combinedHtml.match(/movie_preview/g) || []).length;
    const todayCount = (combinedHtml.match(/today/gi) || []).length;
    console.log(`  Found ${previewCount} 'movie_preview' occurrences, ${todayCount} 'today' occurrences`);
    
    // Parse the HTML to extract sessions
    // Split by movie_preview session divs and process each
    const blocks = combinedHtml.split(/<div[^>]*class="[^"]*movie_preview[^"]*session/i);
    console.log(`  Split into ${blocks.length} blocks`);
    
    let todayBlocks = 0;
    let titleMatches = 0;
    
    // First pass: extract all today's films with their times
    const todayFilms = [];
    
    for (let i = 1; i < blocks.length; i++) { // Start at 1 to skip content before first match
      const block = blocks[i];
      
      // Check if it's today
      if (!/today/i.test(block)) continue;
      todayBlocks++;
      
      // Extract time: "Today at 2pm" or "Today at 6:30pm"
      const timeMatch = block.match(/today\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
      const time = timeMatch ? timeMatch[1].toLowerCase().trim() : 'See website';
      
      // Check if it's a double feature
      const isDouble = /double\s*feature/i.test(block);
      
      // Extract ALL titles from h2 > a tags (there may be multiple for double features)
      const titles = [];
      const urls = [];
      const titleRegex = /<a[^>]*href="([^"]*\/films\/[^"]*)"[^>]*>([^<]+)/gi;
      let match;
      while ((match = titleRegex.exec(block)) !== null) {
        let title = match[2].trim();
        // Remove rating brackets like [PG], [M]
        title = title.replace(/\s*\[.*?\]\s*$/, '').trim();
        if (title && !titles.includes(title)) {
          titles.push(title);
          urls.push(match[1]);
        }
      }
      
      if (titles.length === 0) continue;
      
      if (isDouble && titles.length >= 2) {
        // Double feature - add as combined entry
        todayFilms.push({ 
          title: titles.join(' + '), 
          time, 
          url: urls[0],
          isDouble: true,
          film1: titles[0],
          film2: titles[1]
        });
      } else {
        // Single film
        todayFilms.push({ title: titles[0], time, url: urls[0], isDouble: false });
      }
    }
    
    console.log(`  Today films: ${todayFilms.map(f => f.title + ' @ ' + f.time).join(', ')}`);
    console.log(`  Found ${todayFilms.length} today films before dedup`);
    
    // Dedupe by title (same film might appear in multiple blocks)
    const seenTitles = new Set();
    for (const film of todayFilms) {
      if (seenTitles.has(film.title)) continue;
      seenTitles.add(film.title);
      
      if (film.isDouble) {
        sessions.push({
          title: film.title,
          times: [film.time],
          url: film.url,
          isDoubleFeature: true,
          film1: film.film1,
          film2: film.film2
        });
      } else {
        sessions.push({
          title: film.title,
          times: [film.time],
          url: film.url,
          isDoubleFeature: false
        });
      }
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Astor Theatre scrape error:', error.message);
  }
  
  return { 
    cinema: 'The Astor Theatre', 
    url, 
    sessions
  };
}

async function scrapePalaceComo(page) {
  console.log('Scraping Palace Como...');
  const sessions = [];
  const url = 'https://www.palacecinemas.com.au/cinemas/palace-cinema-como';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(8000);
    
    const result = await page.evaluate((baseUrl) => {
      const items = [];
      const seen = new Set();
      const debug = { linksFound: 0, titlesFound: [], buttonsFound: 0 };
      
      // Find all movie links with actual title text
      document.querySelectorAll('a[href*="/movies/"]').forEach(link => {
        debug.linksFound++;
        const href = link.getAttribute('href');
        if (!href || !href.includes('/movies/')) return;
        
        const title = link.textContent?.trim();
        if (!title || title === 'More Info' || title.length < 2) return;
        if (seen.has(title)) return;
        
        debug.titlesFound.push(title);
        
        // Walk up to find a container with buttons (session times)
        let container = link.parentElement;
        let attempts = 0;
        while (container && attempts < 10) {
          const buttons = container.querySelectorAll('button');
          if (buttons.length > 0) {
            debug.buttonsFound += buttons.length;
            // Found container with buttons
            const times = [];
            buttons.forEach(btn => {
              const btnText = btn.textContent?.trim() || '';
              const timeMatch = btnText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
              if (timeMatch) {
                times.push(timeMatch[1].replace(/\s+/g, ''));
              }
            });
            
            if (times.length > 0) {
              seen.add(title);
              items.push({ 
                title, 
                times, 
                url: href.startsWith('http') ? href : baseUrl + href 
              });
            }
            break;
          }
          container = container.parentElement;
          attempts++;
        }
      });
      
      return { items, debug };
    }, 'https://www.palacecinemas.com.au');
    
    console.log(`  Debug - links: ${result.debug.linksFound}, titles: ${result.debug.titlesFound.slice(0, 3).join(', ')}, buttons: ${result.debug.buttonsFound}`);
    
    for (const film of result.items) {
      sessions.push(film);
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Palace Como scrape error:', error.message);
  }
  
  return { cinema: 'Palace Como', url, sessions };
}

async function scrapePalaceKino(page) {
  console.log('Scraping Palace Kino...');
  const sessions = [];
  const url = 'https://www.palacecinemas.com.au/cinemas/the-kino-melbourne';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(8000);
    
    const films = await page.evaluate((baseUrl) => {
      const items = [];
      const seen = new Set();
      
      // Find all movie links with actual title text
      document.querySelectorAll('a[href*="/movies/"]').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || !href.includes('/movies/')) return;
        
        const title = link.textContent?.trim();
        if (!title || title === 'More Info' || title.length < 2) return;
        if (seen.has(title)) return;
        
        // Walk up to find a container with buttons (session times)
        let container = link.parentElement;
        let attempts = 0;
        while (container && attempts < 10) {
          const buttons = container.querySelectorAll('button');
          if (buttons.length > 0) {
            // Found container with buttons
            const times = [];
            buttons.forEach(btn => {
              const btnText = btn.textContent?.trim() || '';
              const timeMatch = btnText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
              if (timeMatch) {
                times.push(timeMatch[1].replace(/\s+/g, ''));
              }
            });
            
            if (times.length > 0) {
              seen.add(title);
              items.push({ 
                title, 
                times, 
                url: href.startsWith('http') ? href : baseUrl + href 
              });
            }
            break;
          }
          container = container.parentElement;
          attempts++;
        }
      });
      
      return items;
    }, 'https://www.palacecinemas.com.au');
    
    for (const film of films) {
      sessions.push(film);
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Palace Kino scrape error:', error.message);
  }
  
  return { cinema: 'Palace Kino', url, sessions };
}

async function scrapePalaceWestgarth(page) {
  console.log('Scraping Palace Westgarth...');
  const sessions = [];
  const url = 'https://www.palacecinemas.com.au/cinemas/palace-westgarth';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(8000);
    
    const films = await page.evaluate((baseUrl) => {
      const items = [];
      const seen = new Set();
      
      // Find all movie links with actual title text
      document.querySelectorAll('a[href*="/movies/"]').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || !href.includes('/movies/')) return;
        
        const title = link.textContent?.trim();
        if (!title || title === 'More Info' || title.length < 2) return;
        if (seen.has(title)) return;
        
        // Walk up to find a container with buttons (session times)
        let container = link.parentElement;
        let attempts = 0;
        while (container && attempts < 10) {
          const buttons = container.querySelectorAll('button');
          if (buttons.length > 0) {
            // Found container with buttons
            const times = [];
            buttons.forEach(btn => {
              const btnText = btn.textContent?.trim() || '';
              const timeMatch = btnText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
              if (timeMatch) {
                times.push(timeMatch[1].replace(/\s+/g, ''));
              }
            });
            
            if (times.length > 0) {
              seen.add(title);
              items.push({ 
                title, 
                times, 
                url: href.startsWith('http') ? href : baseUrl + href 
              });
            }
            break;
          }
          container = container.parentElement;
          attempts++;
        }
      });
      
      return items;
    }, 'https://www.palacecinemas.com.au');
    
    for (const film of films) {
      sessions.push(film);
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Palace Westgarth scrape error:', error.message);
  }
  
  return { cinema: 'Palace Westgarth', url, sessions };
}

async function scrapePentridge(page) {
  console.log('Scraping Pentridge Cinema...');
  const sessions = [];
  const url = 'https://www.palacecinemas.com.au/cinemas/pentridge-cinema';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(8000);
    
    const films = await page.evaluate((baseUrl) => {
      const items = [];
      const seen = new Set();
      
      // Find all movie links with actual title text
      document.querySelectorAll('a[href*="/movies/"]').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || !href.includes('/movies/')) return;
        
        const title = link.textContent?.trim();
        if (!title || title === 'More Info' || title.length < 2) return;
        if (seen.has(title)) return;
        
        // Walk up to find a container with buttons (session times)
        let container = link.parentElement;
        let attempts = 0;
        while (container && attempts < 10) {
          const buttons = container.querySelectorAll('button');
          if (buttons.length > 0) {
            // Found container with buttons
            const times = [];
            buttons.forEach(btn => {
              const btnText = btn.textContent?.trim() || '';
              const timeMatch = btnText.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
              if (timeMatch) {
                times.push(timeMatch[1].replace(/\s+/g, ''));
              }
            });
            
            if (times.length > 0) {
              seen.add(title);
              items.push({ 
                title, 
                times, 
                url: href.startsWith('http') ? href : baseUrl + href 
              });
            }
            break;
          }
          container = container.parentElement;
          attempts++;
        }
      });
      
      return items;
    }, 'https://www.palacecinemas.com.au');
    
    for (const film of films) {
      sessions.push(film);
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Pentridge Cinema scrape error:', error.message);
  }
  
  return { cinema: 'Pentridge Cinema', url, sessions };
}

async function scrapeImax(page) {
  console.log('Scraping Imax Melbourne...');
  const sessions = [];
  const url = 'https://imaxmelbourne.com.au/session_times_and_tickets';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const films = await page.evaluate(() => {
      const items = [];
      const filmMap = new Map();
      
      // Find all session list items
      document.querySelectorAll('li').forEach(li => {
        const timeEl = li.querySelector('span.time');
        const movieEl = li.querySelector('a.movie');
        
        if (!timeEl || !movieEl) return;
        
        const time = timeEl.textContent?.trim();
        let title = movieEl.textContent?.trim();
        const movieUrl = movieEl.getAttribute('href');
        
        if (!time || !title) return;
        
        // Clean up title - remove rating brackets like [M], [PG]
        title = title.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
        
        // Check if premium is available (has a link, not soldout span)
        const premiumLink = li.querySelector('a.buy-tickets span.label-time');
        const premiumSoldout = li.querySelector('span.buy-tickets.soldout');
        
        let hasPremium = false;
        if (premiumLink && premiumLink.textContent?.trim() === 'Premium') {
          hasPremium = true;
        }
        // If there's a soldout span for Premium, it means premium exists but is sold out
        const premiumExists = hasPremium || (premiumSoldout && premiumSoldout.textContent?.trim() === 'Premium');
        
        // Group by film title
        if (filmMap.has(title)) {
          const film = filmMap.get(title);
          film.times.push(time);
          film.premiumTimes = film.premiumTimes || [];
          if (hasPremium) {
            film.premiumTimes.push(time);
          }
        } else {
          filmMap.set(title, {
            title,
            times: [time],
            premiumTimes: hasPremium ? [time] : [],
            url: movieUrl ? `https://imaxmelbourne.com.au${movieUrl}` : url
          });
        }
      });
      
      filmMap.forEach(film => items.push(film));
      return items;
    });
    
    for (const film of films) {
      sessions.push(film);
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  Imax Melbourne scrape error:', error.message);
  }
  
  return { cinema: 'Imax Melbourne', url, sessions };
}

async function enrichWithTMDB(cinemaData) {
  console.log(`Enriching ${cinemaData.cinema} with TMDB data...`);
  
  for (const session of cinemaData.sessions) {
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

async function main() {
  console.log('='.repeat(60));
  console.log('Melbourne Cinema Scraper');
  console.log('='.repeat(60));
  console.log('Date:', new Date().toLocaleDateString('en-AU', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Australia/Melbourne'
  }));
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
  
  const results = [];
  
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
    scrapeImax
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
  
  console.log('\n' + '='.repeat(60));
  console.log('COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total cinemas: ${results.length}`);
  console.log(`Total films: ${results.reduce((sum, c) => sum + c.sessions.length, 0)}`);
  results.forEach(c => console.log(`  ${c.cinema}: ${c.sessions.length} films`));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
