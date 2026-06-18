import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getEmbedding(text) {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return res.data[0].embedding;
}

async function fetchShopifyProducts() {
  const products = [];
  let url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/products.json?limit=250`;
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN } });
    const data = await res.json();
    products.push(...(data.products || []));
    const link = res.headers.get('link');
    const next = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return products;
}

async function fetchShopifyPages() {
  const res = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/pages.json?limit=250`,
    { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN } }
  );
  const data = await res.json();
  return data.pages || [];
}

export default async function handler(req, res) {
  if (req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const products = await fetchShopifyProducts();
    for (const product of products) {
      const text = [
        product.title,
        product.body_html?.replace(/<[^>]*>/g, '') || '',
        product.tags,
        product.variants?.[0]?.price ? `Price: $${product.variants[0].price}` : ''
      ].filter(Boolean).join(' ');
      const embedding = await getEmbedding(text);
      await supabase.from('products').upsert({
        id: product.id.toString(),
        title: product.title,
        body: product.body_html?.replace(/<[^>]*>/g, '') || '',
        handle: product.handle,
        url: `/products/${product.handle}`,
        price: product.variants?.[0]?.price || '',
        tags: product.tags,
        embedding
      });
    }

    const pages = await fetchShopifyPages();
    for (const page of pages) {
      const text = `${page.title} ${page.body_html?.replace(/<[^>]*>/g, '') || ''}`;
      const embedding = await getEmbedding(text);
      await supabase.from('pages').upsert({
        id: page.id.toString(),
        title: page.title,
        body: page.body_html?.replace(/<[^>]*>/g, '') || '',
        url: `/pages/${page.handle}`,
        embedding
      });
    }

    res.json({ success: true, synced: { products: products.length, pages: pages.length } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
