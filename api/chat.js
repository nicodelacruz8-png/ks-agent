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
      match_count: 8
    });

    if (error) throw error;

    const context = (products || [])
      .map(p => `Product: ${p.title}\nPrice: $${p.price}\nDescription: ${(p.body || '').slice(0, 300)}`)
      .join('\n\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are the Keyline Safety Agent, a professional AI safety equipment expert for Keyline Safety — Australia's leading supplier of height safety and fall protection equipment. Help customers find the right products for their needs. Be concise (2-3 sentences), professional, and reference specific products from the context when available.`
        },
        {
          role: 'user',
          content: `Customer query: ${query}\n\nAvailable products:\n${context || 'No products found.'}`
        }
      ],
      max_tokens: 300,
      temperature: 0.7
    });

    const message = completion.choices[0].message.content;
    const topProducts = (products || []).slice(0, 4).map(p => ({
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
