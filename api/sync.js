import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getBatchEmbeddings(texts) {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts });
  return res.data.map(d => d.embedding);
}

async function fetchAllProducts() {
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

async function fetchAllPages() {
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
    const BATCH = 50;

    const products = await fetchAllProducts();
    const productTexts = products.map(p => [
      p.title,
      p.body_html?.replace(/<[^>]*>/g, '') || '',
      p.tags,
      p.variants?.[0]?.price ? `Price: $${p.variants[0].price}` : ''
    ].filter(Boolean).join(' '));

    const productEmbeddings = [];
    for (let i = 0; i < productTexts.length; i += BATCH) {
      const embeddings = await getBatchEmbeddings(productTexts.slice(i, i + BATCH));
      productEmbeddings.push(...embeddings);
    }

    const productRecords = products.map((p, i) => ({
      id: p.id.toString(),
      title: p.title,
      body: p.body_html?.replace(/<[^>]*>/g, '') || '',
      handle: p.handle,
      url: `/products/${p.handle}`,
      price: p.variants?.[0]?.price || '',
      tags: p.tags,
      embedding: productEmbeddings[i]
    }));

    for (let i = 0; i < productRecords.length; i += BATCH) {
      await supabase.from('products').upsert(productRecords.slice(i, i + BATCH));
    }

    const pages = await fetchAllPages();
    const pageTexts = pages.map(p => `${p.title} ${p.body_html?.replace(/<[^>]*>/g, '') || ''}`);
    const pageEmbeddings = pageTexts.length ? await getBatchEmbeddings(pageTexts) : [];

    const pageRecords = pages.map((p, i) => ({
      id: p.id.toString(),
      title: p.title,
      body: p.body_html?.replace(/<[^>]*>/g, '') || '',
      url: `/pages/${p.handle}`,
      embedding: pageEmbeddings[i]
    }));

    if (pageRecords.length) await supabase.from('pages').upsert(pageRecords);

    res.json({ success: true, synced: { products: products.length, pages: pages.length } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
