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

  const supabase = createClient(process.env.SUPABASE_URL?.trim(), process.env.SUPABASE_SECRET_KEY?.trim());
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY?.trim() });

  try {
    const embRes = await openai.embeddings.create({ model: 'text-embedding-3-small', input: query });
    const embedding = embRes.data[0].embedding;

    // Search products, collections, and articles in parallel
    const [{ data: products }, { data: collections }, { data: articles }] = await Promise.all([
      supabase.rpc('search_products', { query_embedding: embedding, match_count: 12 }),
      supabase.rpc('search_collections', { query_embedding: embedding, match_count: 3 }),
      supabase.rpc('search_articles', { query_embedding: embedding, match_count: 2 })
    ]);

    // Deduplicate products by title
    const seen = new Set();
    const uniqueProducts = (products || []).filter(p => {
      if (seen.has(p.title)) return false;
      seen.add(p.title);
      return true;
    });

    // Build rich context for the AI — includes tags and keywords so it can verify relevance
    const productContext = uniqueProducts.length
      ? uniqueProducts.map(p =>
          `PRODUCT: "${p.title}" | Tags: ${p.tags || 'none'} | Keywords: ${p.keywords || 'none'} | $${p.price || 'POA'}`
        ).join('\n')
      : 'No products matched the relevance threshold for this query.';

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are Alex — the Keyline Safety Agent. You are a certified safety equipment advisor for Keyline Safety, Canada's trusted safety supplier since 1968. You speak as part of the Keyline team ("we carry", "our range", "we stock").

PERSONALITY:
- Knowledgeable and confident, like a trusted safety advisor
- Warm and direct — get to the recommendation fast, no filler
- Professional but conversational — not robotic, not overly casual
- Safety-focused — you understand real worksite needs

TONE RULES:
- Max 3 sentences in your response
- Reference specific product names from the catalogue when they match
- End EVERY response with one short follow-up question (e.g. "What industry or environment is this for?" / "How many workers need to be fitted?" / "Indoor or outdoor use?")
- Never say "I don't have access to" or "I cannot determine" — always find an angle
