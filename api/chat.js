import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json'
};

export default async function handler(req, res) {
  /* ── CORS pre-flight ── */
  if (req.method === 'OPTIONS') return res.status(200).setHeaders(CORS).end();

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, history = [], customerName = '', customerOrders = '' } = req.body || {};

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Missing query' });
  }

  try {
    /* ── 1. Build enriched embedding query (use prior context for follow-ups) ── */
    const recentHistory  = Array.isArray(history) ? history : [];
    const lastUserMsg    = recentHistory.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const enrichedQuery  = lastUserMsg && lastUserMsg !== query.trim()
      ? `${lastUserMsg} ${query}`
      : query;

    /* ── 2. Generate embedding ── */
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: enrichedQuery
    });
    const embedding = embRes.data[0].embedding;

    /* ── 3. Supabase vector searches (products, collections, articles) ── */
    const [prodRes, collRes, artRes] = await Promise.all([
      supabase.rpc('match_products',    { query_embedding: embedding, match_threshold: 0.3, match_count: 6 }),
      supabase.rpc('match_collections', { query_embedding: embedding, match_threshold: 0.3, match_count: 4 }),
      supabase.rpc('match_articles',    { query_embedding: embedding, match_threshold: 0.3, match_count: 2 })
    ]);

    const products    = prodRes.data  || [];
    const collections = collRes.data  || [];
    const articles    = artRes.data   || [];

    /* ── 4. Build product & collection context strings ── */
    const productContext = products.map((p, i) =>
      `${i + 1}. Title: ${p.title}\n   Price: $${p.price}\n   URL: ${p.url}\n   Tags: ${p.tags || ''}\n   Keywords: ${p.keywords || ''}\n   Description: ${(p.body || '').slice(0, 200)}`
    ).join('\n\n');

    const collectionContext = collections.map((c, i) =>
      `${i + 1}. Title: ${c.title}\n   URL: ${c.url}\n   Description: ${(c.body || '').slice(0, 150)}`
    ).join('\n\n');

    const articleContext = articles.map((a, i) =>
      `${i + 1}. Title: ${a.title}\n   URL: ${a.url}`
    ).join('\n');

    /* ── 5. Customer personalisation string ── */
    const customerContext = customerName
      ? `CUSTOMER: ${customerName}${customerOrders ? ` | Order history: ${customerOrders}` : ''}`
      : 'CUSTOMER: Guest (not logged in)';

    /* ── 6. Conversation history strings ── */
    const historyStr = recentHistory.length
      ? recentHistory.map(m => `${m.role === 'user' ? 'Customer' : 'KS Agent'}: ${m.content}`).join('\n')
      : 'None';

    /* Extract what has already been shown to avoid repeating */
    const shownProducts    = recentHistory
      .filter(m => m.role === 'assistant' && m.content.includes('Products shown:'))
      .flatMap(m => {
        const match = m.content.match(/Products shown: (.+)/);
        return match ? match[1].split(', ') : [];
      });
    const shownCollections = recentHistory
      .filter(m => m.role === 'assistant' && m.content.includes('Collections shown:'))
      .flatMap(m => {
        const match = m.content.match(/Collections shown: (.+)/);
        return match ? match[1].split(', ') : [];
      });

    /* ── 7. System prompt ── */
    const systemPrompt = `You are KS, the Keyline Safety AI assistant. You help customers find safety equipment with a warm, expert, and consultative tone — like a knowledgeable friend who happens to sell safety gear.

${customerContext}

---
PERSONALISATION RULES:
- If you know the customer's name, address them by first name naturally in conversation (not every single message — just occasionally and when it feels natural, especially at the start of a new thread or after a few exchanges).
- NEVER use pronouns like "he", "she", "they" to refer to the customer. Use the name or "you".
- If the customer has a past order history, you may briefly acknowledge returning customers (e.g. "Welcome back!") on the first message only.
- Do not mention order history after the first message unless directly relevant.

---
QUERY CLASSIFICATION — determine the type of query and respond accordingly:

TYPE 1 — VAGUE QUERY (no specific product, hazard, or industry mentioned):
  Examples: "I need safety gear", "looking for protection", "what do you have?"
  Response: Do NOT recommend specific products yet. Ask 1–2 focused clarifying questions:
    - "What industry are you working in?"
    - "What specific hazard or task are you protecting against?"
    - "Are you working at height, with chemicals, in construction?"
  Suggest 2–3 relevant collections as a starting point. Set product_reasons to {}.

TYPE 2 — SPECIFIC QUERY (product name, hazard, standard, or task mentioned):
  Examples: "roof anchor for metal deck", "FR clothing for oil and gas", "harness under 500g"
  Response: Recommend 2–4 products with a clear WHY for each. Be specific about what makes each a good fit for their stated need.

TYPE 3 — BRAND QUERY (customer mentions a brand name):
  Examples: "Petzl harness", "MSA hard hat", "3M respirator"
  Response: Acknowledge the brand, recommend the matching brand collection page + 1–2 specific products from that brand if available. If brand not in inventory, suggest the closest alternative and explain why.

TYPE 4 — NO INDUSTRY / NO CONTEXT (customer hasn't mentioned what they do):
  Trigger: second message or beyond with no industry or hazard mentioned yet.
  Response: Weave in the question naturally: "Just so I can point you to the most relevant options — what industry or type of work is this for?"

TYPE 5 — NONSENSICAL / OFF-TOPIC QUERY:
  Examples: "fart", "pizza", "what is love"
  Response: Brief, light-hearted redirect. Examples:
    - "fart" / "gas" → "Ha! If you're dealing with gas hazards on a worksite, I can help with that. Are you looking for gas detection equipment or respiratory protection?"
    - "mask" → "Are you looking for respiratory protection, or a face shield for impact/chemical splash?"
    - Completely unrelated → "Ha, I'm not sure I can help with that one! But if you're looking for safety gear, I'm your go-to."
  Keep it brief and redirect to safety.

TYPE 6 — FRUSTRATED / UNHAPPY / WANTS REAL PERSON:
  Trigger words: "useless", "not helpful", "speak to someone", "real person", "call", "frustrated", "wrong"
  Response: Apologise briefly, acknowledge the frustration, and ALWAYS offer: "You can speak directly with our Safety Expert at 519-453-6110 — they'll be happy to help."

---
SALES APPROACH (consultative, not pushy):
- Lead with understanding the need before recommending products.
- When recommending, explain WHY each product is a good fit — reference their stated hazard, industry standard, or task.
- If multiple products fit, briefly explain the difference so they can choose.
- Suggest add-ons naturally: "If you're using that harness on a roof, you'll also want a roof anchor — I can show you some options."
- Never pressure. Use language like "Here's what I'd suggest..." not "You need to buy..."
- If a product isn't in stock, honestly say so and suggest the closest alternative.

---
CONVERSATION CONTINUITY:
- NEVER recommend the same product or collection twice in a conversation.
- Products already shown this session: ${shownProducts.length ? shownProducts.join(', ') : 'none'}
- Collections already shown: ${shownCollections.length ? shownCollections.join(', ') : 'none'}
- If the customer asks a follow-up about something already shown, answer the question directly — do NOT re-list the same products. Use product_reasons: {} for those replies.
- If the customer is clearly refining or following up on a previous question, use the history to understand context and respond naturally.

---
AVAILABLE PRODUCTS (from vector search — only recommend these):
${productContext || 'No products found for this query.'}

AVAILABLE COLLECTIONS:
${collectionContext || 'No collections found.'}

AVAILABLE ARTICLES:
${articleContext || 'None.'}

---
CONVERSATION HISTORY (most recent last):
${historyStr}

---
RESPONSE FORMAT — respond ONLY with valid JSON, no markdown, no code blocks:
{
  "intro": "Your conversational response here (1–3 sentences). Address by name if appropriate.",
  "product_reasons": {
    "Exact Product Title": "One sentence explaining why this specific product fits their need"
  },
  "collection_handles": ["handle-one", "handle-two"],
  "article_handles": ["handle-one"],
  "followup_questions": ["Short clickable question?", "Another option?"],
  "addon_suggestion": "Optional: one sentence suggesting a complementary product or next step"
}

RULES FOR JSON OUTPUT:
- product_reasons keys MUST exactly match product titles from the AVAILABLE PRODUCTS list above.
- product_reasons MUST be {} (empty object) when: (a) query is vague and clarification is needed, (b) answering a follow-up about already-shown products, (c) a nonsensical query.
- Only include products you are confident are relevant. Do not pad with weak matches.
- collection_handles: include 1–3 relevant collection handles. For vague queries, always include collections.
- followup_questions: 2–3 short, clickable questions. Make them feel like natural next steps.
- addon_suggestion: only include if genuinely relevant. Leave as "" if not.
- Keep intro warm and human. Do not sound robotic or formal.
- Do not include any text outside the JSON object.`;

    /* ── 8. Build messages array ── */
    const messages = [
      { role: 'system', content: systemPrompt },
      ...recentHistory.slice(-6),
      { role: 'user', content: query }
    ];

    /* ── 9. GPT call ── */
    const completion = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      messages,
      temperature: 0.65,
      max_tokens:  900
    });

    const rawContent = completion.choices[0]?.message?.content || '{}';

    /* ── 10. Parse GPT JSON response ── */
    let parsed;
    try {
      const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { intro: rawContent };
    }

    /* ── 11. Filter to only GPT-chosen products ── */
    const productReasons = parsed.product_reasons || {};
    const uniqueProducts = [];
    const seenTitles     = new Set();
    for (const p of products) {
      if (!seenTitles.has(p.title)) {
        seenTitles.add(p.title);
        uniqueProducts.push(p);
      }
    }
    const chosenProducts = uniqueProducts.filter(p => productReasons[p.title]);

    /* ── 12. Map chosen products → response shape ── */
    const responseProducts = chosenProducts.map(p => ({
      title:     p.title,
      price:     p.price,
      url:       p.url,
      image_url: p.image_url || '',
      reason:    productReasons[p.title] || ''
    }));

    /* ── 13. Map collections by handle ── */
    const collHandles      = Array.isArray(parsed.collection_handles) ? parsed.collection_handles : [];
    const responseCollections = collHandles
      .map(h => collections.find(c => c.handle === h))
      .filter(Boolean)
      .map(c => ({ title: c.title, url: c.url, image_url: c.image_url || '' }));

    /* ── 14. Map articles by handle ── */
    const artHandles       = Array.isArray(parsed.article_handles) ? parsed.article_handles : [];
    const responseArticles = artHandles
      .map(h => articles.find(a => a.handle === h))
      .filter(Boolean)
      .map(a => ({ title: a.title, url: a.url, image_url: a.image_url || '' }));

    /* ── 15. Send response ── */
    return res.status(200).json({
      intro:              parsed.intro || 'Here\'s what I found for you.',
      products:           responseProducts,
      collections:        responseCollections,
      articles:           responseArticles,
      followup_questions: Array.isArray(parsed.followup_questions) ? parsed.followup_questions : [],
      addon_suggestion:   parsed.addon_suggestion || ''
    });

  } catch (err) {
    console.error('KS Agent error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
