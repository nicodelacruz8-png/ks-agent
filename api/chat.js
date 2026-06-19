import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const supabase = createClient(
    process.env.SUPABASE_URL?.trim(),
    process.env.SUPABASE_SECRET_KEY?.trim()
  );
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY?.trim() });

  try {
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query
    });
    const embedding = embRes.data[0].embedding;

    const { data: products, error } = await supabase.rpc('search_products', {
      query_embedding: embedding,
      match_count: 12
    });

    if (error) throw error;

    // Deduplicate by title before building context
    const seen = new Set();
    const unique = (products || []).filter(p => {
      if (seen.has(p.title)) return false;
      seen.add(p.title);
      return true;
    });

    const context = unique
      .map(p => `- ${p.title} | Price: $${p.price || 'POA'} | Tags: ${p.tags || ''} | ${(p.body || '').slice(0, 200)}`)
      .join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are the Keyline Safety Agent — a knowledgeable, professional safety equipment advisor for Keyline Safety, a leading Canadian supplier of safety equipment since 1968.

Keyline Safety's product range includes:
- Height Safety & Fall Protection: harnesses, lanyards, self-retracting lifelines (SRLs), anchor points, rope access, rescue kits
- Respiratory Protection: disposable respirators, half-face & full-face respirators, PAPRs, supplied air systems, cartridges & filters
- Head Protection: hard hats, bump caps, climbing helmets
- Eye & Face Protection: safety glasses, goggles, face shields, welding helmets
- Hand Protection: cut-resistant gloves, chemical gloves, impact gloves, heat & cold protection
- Hi-Vis & Body Protection: high-visibility vests, jackets, coveralls, rain gear, arc flash
- Foot Protection: safety boots, metatarsal guards
- Hearing Protection: earplugs, banded earplugs, earmuffs
- Confined Space: gas detectors, tripods, winches, rescue equipment
- First Aid & Emergency: spill kits, first aid kits, eyewash stations

Key brands: 3M, MSA, Honeywell, DBI-SALA, Ansell, Ergodyne, PIP, Uvex, Moldex, JSP, Draeger, Miller, Protecta.

RULES:
1. ALWAYS recommend the most relevant products from the catalogue below — reference them by name.
2. If the exact product isn't listed, find the closest match from what IS in the catalogue and recommend it.
3. NEVER say "we don't carry this" or "not in our inventory" — always find something helpful.
4. Keep responses to 2-3 sentences. Be professional, warm, and direct.
5. End with a short invitation like "Would you like more details?" or "Let me know if you need a specific size or spec."`
        },
        {
          role: 'user',
          content: `Customer is looking for: ${query}\n\nMatching products from our catalogue:\n${context || 'No direct matches — recommend based on your knowledge of the store.'}`
        }
      ],
      max_tokens: 280,
      temperature: 0.5
    });

    const message = completion.choices[0].message.content;
    const topProducts = unique.slice(0, 4).map(p => ({
      title: p.title,
      price: p.price,
      url: p.url,
      image_url: p.image_url || ''
    }));

    res.json({ message, products: topProducts });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
