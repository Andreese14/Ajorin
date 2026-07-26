// /api/generate-brief.js
//
// Vercel serverless function. Any file in an /api folder at the root of
// your GitHub repo automatically becomes a live endpoint once deployed.
//
// Pipeline:
//   1. Google Places API  → real, current venues in the chosen city, across
//      three categories: food/coffee, shopping/local stores, activities
//   2. Gemini             → bundles them into day-by-day plans (not a flat
//      single pick), tailored to this specific person, and writes a genuinely
//      unique closing letter for this city (not a fill-in-the-blank template)
//
// Called from the frontend like:
//   fetch('/api/generate-brief', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ city, profile })
//   })

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  const { city, profile } = req.body || {};

  if (!city || !profile) {
    return res.status(400).json({ error: 'Missing city or profile in request body' });
  }

  const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GOOGLE_KEY || !GEMINI_KEY) {
    return res.status(500).json({ error: 'Server is missing required API keys' });
  }

  try {
    // ── Step 1: Pull real, current venues across three categories ──
    const [foodResults, shopResults, activityResults] = await Promise.all([
      searchPlaces(buildFoodQuery(profile, city), GOOGLE_KEY),
      searchPlaces(buildShopQuery(profile, city), GOOGLE_KEY),
      searchPlaces(buildActivityQuery(profile, city), GOOGLE_KEY)
    ]);

    const candidates = [...foodResults, ...shopResults, ...activityResults]
      .filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY');

    if (candidates.length === 0) {
      return res.status(200).json({
        error: 'No current venues found for this city — falling back to default brief.',
        fallback: true
      });
    }

    // ── Step 2: Ask Gemini to bundle these into day-by-day plans + a real letter ──
    const matched = await matchWithGemini(profile, city, candidates);

    // Safety net: wherever Google Places has a real editorial summary for a
    // matched venue, prefer that over Gemini's guess — keeps "about this
    // place" grounded in real data whenever it exists.
    if (matched.days) {
      matched.days.forEach(day => {
        (day.stops || []).forEach(stop => {
          const realMatch = candidates.find(c => c.name === stop.name);
          if (realMatch && realMatch.summary) {
            stop.about = realMatch.summary;
          }
        });
      });
    }

    return res.status(200).json(matched);

  } catch (err) {
    console.error('generate-brief failed:', err);
    return res.status(500).json({ error: 'Something went wrong generating this brief.' });
  }
}

// ── Query builders ──

function buildFoodQuery(profile, city) {
  const dietary = (profile.dietary || '').toLowerCase();
  const foodPref = profile.food || '';
  if (dietary.includes('vegetarian') || dietary.includes('vegan')) {
    return `best vegetarian and vegan friendly restaurants and cafes in ${city}`;
  }
  if (foodPref.includes('Street food')) return `best street food and local food spots in ${city}`;
  if (foodPref.includes('Michelin') || foodPref.includes('fine dining')) return `best fine dining restaurants in ${city}`;
  return `best local restaurants and cafes in ${city}`;
}

function buildShopQuery(profile, city) {
  const interests = (profile.interests || '').toLowerCase();
  if (interests.includes('book')) return `best independent bookstores in ${city}`;
  if (interests.includes('thrift') || interests.includes('vintage')) return `best vintage and thrift shops in ${city}`;
  return `best local markets and independent shops in ${city}`;
}

function buildActivityQuery(profile, city) {
  const draw = profile.culture_draw || '';
  if (draw.includes('Museums')) return `best museums and historic sites in ${city}`;
  if (draw.includes('nightlife')) return `best live music and nightlife spots in ${city}`;
  if (draw.includes('Markets')) return `best local markets and everyday neighborhoods in ${city}`;
  if (draw.includes('Nature')) return `best parks and quiet natural spaces in ${city}`;
  return `top rated things to do in ${city}`;
}

async function searchPlaces(query, apiKey) {
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.businessStatus,places.editorialSummary,places.types'
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 8 })
  });

  if (!response.ok) {
    console.error('Places API error:', await response.text());
    return [];
  }

  const data = await response.json();
  return (data.places || []).map(p => ({
    name: p.displayName?.text || 'Unknown',
    address: p.formattedAddress || '',
    rating: p.rating || null,
    businessStatus: p.businessStatus || 'OPERATIONAL',
    summary: p.editorialSummary?.text || ''
  }));
}

async function matchWithGemini(profile, city, candidates) {
  const firstName = (profile.name || '').trim().split(/\s+/)[0] || 'Traveler';

  const prompt = `You are Ajorin, a personalized travel discovery assistant. Your voice is warm, specific, and conversational — like a knowledgeable local friend, never a generic travel guide. Never say "Day 1: Where to eat" type labels — write like you're texting a friend a real plan.

A user named ${firstName} has this saved profile:
${JSON.stringify(profile, null, 2)}

Here is a real, current list of venues in ${city} (from Google Places, so these are genuinely open right now):
${JSON.stringify(candidates, null, 2)}

Build a 3-day plan using ONLY the venues in the list above — never invent places not listed. Each day should bundle 3 real stops that make sense together (a food/coffee spot, a shop or market, and an activity or landmark), written with a short, warm reason each was picked for ${firstName} specifically.

For each stop, also include a short factual "about" line (1 sentence, what the place actually is) — use the venue's real summary from the list above if one exists; if it doesn't, write a brief, honest factual description based only on its name and category, without inventing specific claims you can't support.

Also write a short, genuinely unique closing letter "from" ${city} itself — personal, specific to what this profile seems to actually want, NOT a generic "you came looking for X" template. Make it feel like it could only be written for ${city}, referencing something true and specific about the city's actual character.

Return STRICT JSON, no markdown, no commentary, in exactly this shape:

{
  "days": [
    {
      "theme": "A short, warm 4-6 word theme for this day",
      "stops": [
        { "category": "Coffee", "name": "Venue Name From The List", "why": "One warm sentence, specific to ${firstName}", "about": "One factual sentence about what this place is" },
        { "category": "Shopping", "name": "Venue Name From The List", "why": "One warm sentence", "about": "One factual sentence" },
        { "category": "Activity", "name": "Venue Name From The List", "why": "One warm sentence", "about": "One factual sentence" }
      ]
    }
  ],
  "letter": "The genuinely unique closing letter text, 3-5 sentences, in ${city}'s own voice."
}

Include exactly 3 day objects.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    }
  );

  if (!response.ok) {
    throw new Error('Gemini API error: ' + await response.text());
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) throw new Error('Gemini returned no content');

  return JSON.parse(text);
}
