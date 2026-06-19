import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { buildSystemPrompt, classifyQueryForPrompt } from './chat-instructions.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

let supabaseClient;
let openaiClient;

function setCorsHeaders(res) {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => res.setHeader(key, value));
}

function getSupabase() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  }

  supabaseClient = createClient(url, key);
  return supabaseClient;
}

function getOpenAI() {
  if (openaiClient) return openaiClient;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

function safeText(value, maxLength = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeTitle(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSearchText(value) {
  return normalizeTitle(value).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  return (items || []).filter(item => {
    const key = getKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(m => m && typeof m.content === 'string')
    .map(m => ({
      ...m,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: safeText(m.content, 2000)
    }))
    .slice(-8);
}

function buildEmbeddingQuery(query, history) {
  const recentUserContext = history
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content)
    .join(' ');

  return safeText(`${recentUserContext} ${query}`, 900);
}

function contextFromHistory(history, fieldName, marker) {
  const values = [];

  for (const message of history) {
    if (Array.isArray(message[fieldName])) {
      values.push(...message[fieldName]);
    }

    if (typeof message.content === 'string' && message.content.includes(marker)) {
      const match = message.content.match(new RegExp(`${marker}:\\s*(.+)`, 'i'));
      if (match) values.push(...match[1].split(',').map(v => v.trim()));
    }
  }

  return values.filter(Boolean);
}

function cleanStringArray(value) {
  return Array.isArray(value) ? value.map(v => String(v || '').trim()).filter(Boolean) : [];
}

function historyToPrompt(history) {
  if (!history.length) return 'None';

  return history
    .map(m => `${m.role === 'user' ? 'Customer' : 'Keisha'}: ${m.content}`)
    .join('\n');
}

function findMentionedCollection(query, collections) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return null;

  return (collections || []).find(collection => {
    const title = normalizeSearchText(collection.title);
    const handle = normalizeSearchText(collection.handle);
    return Boolean(
      (title && normalizedQuery.includes(title)) ||
      (handle && normalizedQuery.includes(handle))
    );
  }) || null;
}

function buildProductContext(products) {
  return products.map((p, index) => [
    `${index + 1}. Title: ${p.title}`,
    `   Handle: ${p.handle || ''}`,
    `   Price: ${p.price ? `$${p.price}` : 'Contact for price'}`,
    `   URL: ${p.url || (p.handle ? `/products/${p.handle}` : '')}`,
    `   Tags: ${p.tags || ''}`,
    `   Keywords: ${p.keywords || ''}`,
    `   Description: ${safeText(p.body, 240)}`
  ].join('\n')).join('\n\n');
}

function buildCollectionContext(collections) {
  return collections.map((c, index) => [
    `${index + 1}. Title: ${c.title}`,
    `   Handle: ${c.handle || ''}`,
    `   URL: ${c.url || (c.handle ? `/collections/${c.handle}` : '')}`,
    `   Description: ${safeText(c.body, 180)}`
  ].join('\n')).join('\n\n');
}

function buildArticleContext(articles) {
  return articles.map((a, index) => [
    `${index + 1}. Title: ${a.title}`,
    `   Handle: ${a.handle || ''}`,
    `   URL: ${a.url || ''}`
  ].join('\n')).join('\n\n');
}

function parseJsonModelOutput(rawContent) {
  try {
    const cleaned = String(rawContent || '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    return JSON.parse(cleaned || '{}');
  } catch {
    return {
      intro: String(rawContent || '').trim(),
      product_reasons: {},
      collection_handles: [],
      article_handles: [],
      followup_questions: [],
      quick_replies: [],
      addon_suggestion: ''
    };
  }
}

function reasonForProduct(product, productReasons) {
  if (!productReasons || typeof productReasons !== 'object') return '';
  if (productReasons[product.title]) return productReasons[product.title];

  const normalizedTitle = normalizeTitle(product.title);
  const match = Object.entries(productReasons)
    .find(([title]) => normalizeTitle(title) === normalizedTitle);

  return match?.[1] || '';
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    query,
    history = [],
    customerName = '',
    customerOrders = '',
    shownProducts: shownProductsFromClient = [],
    shownCollections: shownCollectionsFromClient = []
  } = req.body || {};

  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) {
    return res.status(400).json({ error: 'Missing query' });
  }

  try {
    const supabase = getSupabase();
    const openai = getOpenAI();
    const recentHistory = sanitizeHistory(history);
    const classification = classifyQueryForPrompt(cleanQuery, recentHistory);
    const embeddingQuery = buildEmbeddingQuery(cleanQuery, recentHistory);

    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: embeddingQuery
    });

    const embedding = embRes.data[0]?.embedding;
    if (!embedding) {
      throw new Error('Embedding request did not return a vector');
    }

    const [prodRes, collRes, artRes] = await Promise.all([
      supabase.rpc('search_products', { query_embedding: embedding, match_count: 12 }),
      supabase.rpc('search_collections', { query_embedding: embedding, match_count: 6 }),
      supabase.rpc('search_articles', { query_embedding: embedding, match_count: 2 })
    ]);

    if (prodRes.error) throw new Error(`Product search failed: ${prodRes.error.message}`);
    if (collRes.error) throw new Error(`Collection search failed: ${collRes.error.message}`);
    if (artRes.error) throw new Error(`Article search failed: ${artRes.error.message}`);

    const products = uniqueBy(prodRes.data || [], p => normalizeTitle(p.title));
    const collections = uniqueBy(collRes.data || [], c => c.handle || normalizeTitle(c.title));
    const articles = uniqueBy(artRes.data || [], a => a.handle || normalizeTitle(a.title));
    const mentionedCollection = findMentionedCollection(cleanQuery, collections);

    if (mentionedCollection && !classification.isFrustrated) {
      classification.label = classification.isBrandQuery ? classification.label : 'collection_or_category';
      classification.mustClarifyFirst = false;
      classification.mentionedCollectionTitle = mentionedCollection.title;
      classification.guidance = [
        classification.guidance,
        `The customer mentioned or closely matched the available collection "${mentionedCollection.title}". Treat that as clear enough to recommend relevant products now. Include that collection page if useful, and ask follow-up questions after the product suggestions.`
      ].filter(Boolean).join(' ');
    }

    const shownProducts = uniqueBy([
      ...cleanStringArray(shownProductsFromClient),
      ...contextFromHistory(recentHistory, 'shownProducts', 'Products shown'),
      ...contextFromHistory(recentHistory, 'productsShown', 'Products shown'),
      ...contextFromHistory(recentHistory, 'recommendedProducts', 'Products recommended')
    ].map(title => ({ title })), item => normalizeTitle(item.title)).map(item => item.title);

    const shownCollections = uniqueBy([
      ...cleanStringArray(shownCollectionsFromClient),
      ...contextFromHistory(recentHistory, 'shownCollections', 'Collections shown'),
      ...contextFromHistory(recentHistory, 'collectionsShown', 'Collections shown')
    ].map(title => ({ title })), item => normalizeTitle(item.title)).map(item => item.title);

    const systemPrompt = buildSystemPrompt({
      customerName,
      customerOrders,
      classification,
      shownProducts,
      shownCollections,
      productContext: buildProductContext(products),
      collectionContext: buildCollectionContext(collections),
      articleContext: buildArticleContext(articles),
      historyStr: historyToPrompt(recentHistory),
      isFirstTurn: recentHistory.length === 0
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...recentHistory.map(m => ({ role: m.role, content: m.content })),
      {
        role: 'user',
        content: `Customer query: "${cleanQuery}"\n\n${classification.guidance}`
      }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages,
      temperature: 0.45,
      max_tokens: 900
    });

    const parsed = parseJsonModelOutput(completion.choices[0]?.message?.content);
    const productReasons = classification.mustClarifyFirst || classification.isFrustrated
      ? {}
      : (parsed.product_reasons && typeof parsed.product_reasons === 'object' ? parsed.product_reasons : {});

    const shownProductSet = new Set(shownProducts.map(normalizeTitle));
    const shownCollectionSet = new Set(shownCollections.map(normalizeTitle));
    const chosenProducts = products
      .map(product => ({
        ...product,
        reason: reasonForProduct(product, productReasons)
      }))
      .filter(product => product.reason && !shownProductSet.has(normalizeTitle(product.title)))
      .slice(0, 4);

    const requestedCollectionHandles = cleanStringArray(parsed.collection_handles);
    const collectionByHandle = new Map(collections.map(c => [String(c.handle || '').toLowerCase(), c]));
    let responseCollections = requestedCollectionHandles
      .map(handle => collectionByHandle.get(handle.toLowerCase()))
      .filter(collection =>
        collection &&
        !shownCollectionSet.has(normalizeTitle(collection.title)) &&
        !shownCollectionSet.has(normalizeTitle(collection.handle))
      );

    if (!responseCollections.length && (classification.mustClarifyFirst || !chosenProducts.length)) {
      responseCollections = collections
        .filter(collection =>
          !shownCollectionSet.has(normalizeTitle(collection.title)) &&
          !shownCollectionSet.has(normalizeTitle(collection.handle))
        )
        .slice(0, 3);
    }

    const requestedArticleHandles = cleanStringArray(parsed.article_handles);
    const articleByHandle = new Map(articles.map(a => [String(a.handle || '').toLowerCase(), a]));
    const responseArticles = requestedArticleHandles
      .map(handle => articleByHandle.get(handle.toLowerCase()))
      .filter(Boolean)
      .slice(0, 2);

    return res.status(200).json({
      intro: parsed.intro || 'I can help narrow that down. What type of work or hazard are you shopping for?',
      products: chosenProducts.map(p => ({
        title: p.title,
        price: p.price,
        url: p.url,
        image_url: p.image_url || '',
        reason: p.reason
      })),
      collections: responseCollections.slice(0, 3).map(c => ({
        title: c.title,
        url: c.url,
        image_url: c.image_url || ''
      })),
      articles: responseArticles.map(a => ({
        title: a.title,
        url: a.url,
        image_url: a.image_url || ''
      })),
      followup_questions: cleanStringArray(parsed.followup_questions).slice(0, 3),
      quick_replies: cleanStringArray(parsed.quick_replies).slice(0, 4),
      addon_suggestion: String(parsed.addon_suggestion || ''),
      memory: {
        products_shown: uniqueBy([
          ...shownProducts.map(title => ({ title })),
          ...chosenProducts.map(p => ({ title: p.title }))
        ], item => normalizeTitle(item.title)).map(item => item.title),
        collections_shown: uniqueBy([
          ...shownCollections.map(title => ({ title })),
          ...responseCollections.map(c => ({ title: c.title }))
        ], item => normalizeTitle(item.title)).map(item => item.title)
      }
    });
  } catch (err) {
    console.error('Keisha chat error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
}
