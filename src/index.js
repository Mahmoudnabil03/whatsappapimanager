export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS Pre-flight (Keeps the dashboard connection alive)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // 2. Admin API
    if (url.pathname === "/api/admin/messages" && request.method === "GET") {
      const { results } = await env.aqarx_db.prepare("SELECT * FROM chat_history ORDER BY timestamp DESC LIMIT 50").all();
      return Response.json(results, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // 3. Webhook Verification
    if (request.method === "GET" && url.searchParams.has("hub.verify_token")) {
      return new Response(url.searchParams.get("hub.challenge"), { status: 200 });
    }

    // 4. WhatsApp Message Handler
    if (request.method === "POST") {
      const body = await request.json();
      ctx.waitUntil(processIncomingMessage(body, env));
      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function processIncomingMessage(body, env) {
  const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;

  const customerPhone = message.from;
  const userText = message.text.body;

  // Save User Message
  await env.aqarx_db.prepare("INSERT INTO chat_history (customer_phone, role, content) VALUES (?, 'user', ?)").bind(customerPhone, userText).run();

  // Get AI Response
  const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", { 
    messages: [{ role: "system", content: "You are a real estate advisor for AQARX." }, { role: "user", content: userText }] 
  });
  const botReply = aiResponse.response;

  // Save AI Response
  await env.aqarx_db.prepare("INSERT INTO chat_history (customer_phone, role, content) VALUES (?, 'assistant', ?)").bind(customerPhone, botReply).run();

  // Send back to WhatsApp
  await fetch(`https://graph.facebook.com/v20.0/${env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: customerPhone, text: { body: botReply } })
  });
}