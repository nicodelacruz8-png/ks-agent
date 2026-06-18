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

  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'Messages required' });

  try {
    const latestMessage = messages[messages.length - 1].content;

    const embeddingRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: latestMessage
    });
    const embedding = embeddingRes.data[0].embedding;

    const { data: products } = await supabase.rpc('search_products', {
      query_embedding: embedding,
      match_count: 5
    });

    const { data: pages } = await supabase.rpc('search_pages', {
      query_embedding: embedding,
      match_count: 3
    });

    const productContext = products?.map(p =>
      `Product: ${p.title}\nPrice: $${p.price}\nDescription: ${p.body?.slice(0, 200)}\nURL: ${p.url}`
    ).join('\n\n') || 'No products found.';

    const pageContext = pages?.map(p =>
      `Page: ${p.title}\nContent: ${p.body?.slice(0, 300)}\nURL: ${p.url}`
    ).join('\n\n') || '';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are KS Agent, a helpful AI assistant for Keyline Safety — a safety equipment store. You help customers find the right safety products and answer questions about the store.

Only answer based on the store content below. If something isn't in the store, say so honestly. Always be helpful and suggest relevant products when possible.

Store Products:
${productContext}

Store Pages:
${pageContext}`
        },
        ...messages
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    res.json({ message: response.choices[0].message.content });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
