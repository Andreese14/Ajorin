// /api/generate-brief.js
//
// Vercel serverless function. Any file in an /api folder at the root of
// your GitHub repo automatically becomes a live endpoint once deployed —
// no extra setup needed beyond uploading this file to /api/generate-brief.js
//
// This replaces the static, hand-written briefLibrary lookup in
// dashboard.html with a real pipeline:
//   1. Google Places API  → real, current venues in whatever city was chosen
//   2. Gemini             → picks the best matches for this specific person
//                            and writes the "why" in Ajorin's voice
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
    // ── Step 1: Pull real, current venues from Google Places ──
    const [foodResults, activityResults] = await Promise.all([
      searchPlaces(buildFoodQuery(profile, city), GOOGLE_KEY),
      searchPlaces(buildActivityQuery(profile, city), GOOGLE_KEY)
    ]);

    const candidates = [...foodResults, ...activityResults]
      .filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY')
      .slice(0, 16);

    if (candidates.length === 0) {
      return res.status(200).json({
        error: 'No current venues found for this city — falling back to default brief.',
        fallback: true
      });
    }

    // ── Step 2: Ask Gemini to pick and explain the best matches ──
    const matched = await matchWithGemini(profile, city, candidates);

    return res.status(200).json(matched);

  } catch (err) {
    console.error('generate-brief failed:', err);
    return res.status(500).json({ error: 'Something went wrong generating this brief.' });
  }
}

// ── Helpers ──

function buildFoodQuery(profile, city) {
  const dietary = profile.dietary || '';
  const foodPref = profile.food || '';
  if (dietary.toLowerCase().includes('vegetarian') || dietary.toLowerCase().includes('vegan')) {
    return `best vegetarian and vegan friendly restaurants in ${city}`;
  }
  if (foodPref.includes('Street food')) return `best street food and local food spots in ${city}`;
  if (foodPref.includes('Michelin') || foodPref.includes('fine dining')) return `best fine dining restaurants in ${city}`;
  return `best local restaurants in ${city}`;
}

function buildActivityQuery(profile, city) {
  const draw = profile.culture_draw || '';
  if (draw.includes('Museums')) return `best museums and historic sites in ${city}`;
  if (draw.includes('nightlife')) return `best live music and nightlife spots in ${city}`;
  if (draw.includes('Markets')) return `best local markets in ${city}`;
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
  const prompt = `You are Ajorin, a personalized travel discovery assistant. Your voice is warm, specific, and conversational — like a knowledgeable local friend, never a generic travel guide.

A user has this saved profile:
${JSON.stringify(profile, null, 2)}

Here is a real, current list of venues in ${city} (from Google Places, so these are genuinely open right now):
${JSON.stringify(candidates, null, 2)}

Pick the best matches for this specific person from the list above ONLY — do not invent places not in this list. Return STRICT JSON, no markdown, no commentary, in exactly this shape:

{
  "eat": "Venue Name — one sentence in Ajorin's concierge voice explaining the recommendation",
  "activity": "Venue Name — one sentence in Ajorin's concierge voice",
  "tip": "One sentence of local-feeling insider advice, not a specific venue",
  "ifYouHaveTime": ["Venue Name 1", "Venue Name 2"]
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
