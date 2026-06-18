import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', `https://${process.env.SHOPIFY_STORE_DOMAIN}`);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query required' });

  try {
    const embeddingRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query
    });
    const embedding = embeddingRes.data[0].embedding;

    const { data: products, error } = await supabase.rpc('search_products', {
      query_embedding: embedding,
      match_count: 8
    });

    if (error) throw error;

    res.json({ products: products || [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
