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
  const url = `https://www.acmi.net.au/whats-on/?what=film&when_start=${dateStr}&when_end=${dateStr}`;
  
  console.log(`  URL: ${url}`);
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const films = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('a[href*="/whats-on/"]').forEach(el => {
        const href = el.href;
        if (href === 'https://www.acmi.net.au/whats-on/' || href.includes('?')) return;
        
        const titleEl = el.querySelector('h2, h3, h4, [class*="title"]');
        const title = titleEl?.textContent?.trim();
        const timeEl = el.querySelector('[class*="time"], [class*="date"], time, p');
        let time = timeEl?.textContent?.trim() || '';
        
        // Try to extract actual time
        const timeMatch = time.match(/\d{1,2}[:.]\d{2}\s*(am|pm)?/i);
        time = timeMatch ? timeMatch[0] : 'See website';
        
        if (title && title.length > 2) {
          const skipWords = ['exhibition', 'game worlds', 'story of the moving image', 'talk', 'workshop', 'visit'];
          const titleLower = title.toLowerCase();
          if (skipWords.some(word => titleLower.includes(word))) return;
          
          items.push({ title, time, url: href });
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
          times: [film.time],
          url: film.url
        });
      }
    }
    
    console.log(`  Found ${sessions.length} films`);
  } catch (error) {
    console.error('  ACMI scrape error:', error.message);
  }
  
  return { cinema: 'ACMI', url, sessions };
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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const films = await page.evaluate((todayStr) => {
      const items = [];
      
      // Find all film entries that have today's date in their class
      // Classes look like: veezi-f-date-Mon-29-Dec
      const todayClass = `veezi-f-date-${todayStr}`;
      const filmEntries = document.querySelectorAll(`.veezi-filter-entry.${CSS.escape(todayClass)}`);
      
      filmEntries.forEach(entry => {
        // Get title from the filter-film-title div
        const titleEl = entry.querySelector('.veezi-filter-film-title');
        const title = titleEl?.textContent?.trim();
        
        if (!title) return;
        
        // Get times - only visible ones for today's date
        // Time links have classes like: veezi-time-ST00000146-Mon-29-Dec
        const times = [];
        const timeClass = `veezi-time-${todayStr}`;
        
        entry.querySelectorAll(`a.veezi-film-purchase`).forEach(link => {
          // Check if this time is for today (has the date class) and is visible
          if (link.classList.toString().includes(todayStr) && 
              link.style.display !== 'none') {
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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const films = await page.evaluate(() => {
      const items = [];
      
      // Each session is in div.movie_preview.session
      document.querySelectorAll('div.movie_preview.session').forEach(sessionDiv => {
        // Get the date/time text (e.g., "Today at 2pm", "Tomorrow at 7pm")
        const dateTimeEl = sessionDiv.querySelector('span.extrabold');
        const dateTimeText = dateTimeEl?.textContent?.trim() || '';
        
        // Only include "Today" sessions
        if (!dateTimeText.toLowerCase().includes('today')) {
          return;
        }
        
        // Extract just the time part (e.g., "2pm", "6:30pm")
        const timeMatch = dateTimeText.match(/at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
        const time = timeMatch ? timeMatch[1] : 'See website';
        
        // Check if single or double feature
        const isDouble = sessionDiv.classList.contains('double');
        
        // Get film title(s) from h2.uppercase a elements
        const titleLinks = sessionDiv.querySelectorAll('h2.uppercase a');
        const titles = [];
        titleLinks.forEach(link => {
          // Get text but remove the rating span like [PG], [M], etc.
          let title = link.textContent?.trim() || '';
          title = title.replace(/\s*\[.*?\]\s*$/, '').trim();
          if (title) {
            titles.push(title);
          }
        });
        
        if (titles.length === 0) return;
        
        // Get the session info URL
        const sessionLink = sessionDiv.querySelector('a.movie_link');
        const sessionUrl = sessionLink?.href || url;
        
        if (isDouble && titles.length >= 2) {
          // Double feature - combine titles
          items.push({
            title: titles.join(' + '),
            times: [time],
            url: sessionUrl,
            isDoubleFeature: true,
            film1: titles[0],
            film2: titles[1]
          });
        } else {
          // Single feature
          items.push({
            title: titles[0],
            times: [time],
            url: sessionUrl,
            isDoubleFeature: false
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
    console.error('  Astor Theatre scrape error:', error.message);
  }
  
  return { 
    cinema: 'The Astor Theatre', 
    url, 
    sessions
  };
}

async function enrichWithTMDB(cinemaData) {
  console.log(`Enriching ${cinemaData.cinema} with TMDB data...`);
  
  for (const session of cinemaData.sessions) {
    if (session.isDoubleFeature && (session.title.includes(' + ') || session.title.includes(' & '))) {
      const separator = session.title.includes(' + ') ? ' + ' : ' & ';
      const titles = session.title.split(separator);
      session.films = [];
      
      for (const title of titles) {
        const tmdb = await fetchTMDB(title.trim());
        session.films.push({ title: title.trim(), ...tmdb });
        await new Promise(r => setTimeout(r, 250));
      }
      
      if (session.films[0]?.posterPath) {
        session.posterPath = session.films[0].posterPath;
      }
      if (session.films[0]?.overview) {
        session.overview = session.films[0].overview;
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
