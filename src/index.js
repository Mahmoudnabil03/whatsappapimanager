export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- ADMIN DASHBOARD: FETCH MESSAGES ---
    // Access this via your worker URL: /api/admin/messages
    if (url.pathname === "/api/admin/messages" && request.method === "GET") {
      try {
        const { results } = await env.aqarx_db.prepare(
          "SELECT * FROM chat_history ORDER BY timestamp DESC LIMIT 50"
        ).all();
        return Response.json(results, { 
          headers: { "Access-Control-Allow-Origin": "*" } 
        });
      } catch (err) {
        return new Response("Database Error", { status: 500 });
      }
    }

    // 1. Webhook Verification (GET)
    if (request.method === "GET") {
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (token === env.MY_VERIFY_TOKEN) {
        return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // 2. Multi-Platform Message Handler (POST)
    if (request.method === "POST") {
      try {
        const body = await request.json();
        
        // Delegate to background processing
        ctx.waitUntil(processIncomingMessage(body, env));

        // Return 200 immediately
        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (error) {
        console.error("❌ Critical Request Parse Error:", error);
        return new Response("OK", { status: 200 });
      }
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};

// --- BACKGROUND PROCESSOR ---
async function processIncomingMessage(body, env) {
  try {
    // --- PLATFORM A: WHATSAPP ---
    if (body.object === "whatsapp_business_account") {
      const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (message?.text) {
        const customerPhone = message.from;
        const botReplyText = await getAiResponse(env, customerPhone, message.text.body);
        
        await fetch(`https://graph.facebook.com/v20.0/1214182878437204/messages`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: customerPhone, type: "text", text: { body: botReplyText } })
        });
      }
    } 
    // --- PLATFORM B: MESSENGER / INSTAGRAM ---
    else if (body.object === "page" || body.object === "instagram") {
      const messagingEvent = body.entry?.[0]?.messaging?.[0];
      if (messagingEvent?.message && !messagingEvent.message.is_echo) {
        const senderId = messagingEvent.sender.id;
        const incomingText = messagingEvent.message.text;
        const botReplyText = await getAiResponse(env, senderId, incomingText);
        const token = body.object === "instagram" ? env.INSTAGRAM_ACCESS_TOKEN : env.MESSENGER_ACCESS_TOKEN;

        await fetch(`https://graph.facebook.com/v20.0/me/messages`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ recipient: { id: senderId }, message: { text: botReplyText } })
        });
      }
    }
  } catch (err) {
    console.error("❌ Background Processing Error:", err);
  }
}

// 🧠 AI & D1 ENGINE
async function getAiResponse(env, userId, incomingText) {
  await env.aqarx_db.prepare("INSERT INTO chat_history (customer_phone, role, content) VALUES (?, 'user', ?)").bind(userId, incomingText).run();
  const { results } = await env.aqarx_db.prepare("SELECT role, content FROM chat_history WHERE customer_phone = ? ORDER BY timestamp DESC LIMIT 6").bind(userId).all();
  const priorMessages = results.reverse();
  const messagesPayload = [
    { role: "system", content: "You are an elite, professional real estate sales advisor for AQARX..." },
    ...priorMessages
  ];
  const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", { messages: messagesPayload });
  const botReplyText = aiResponse.response || aiResponse.result?.response;
  await env.aqarx_db.prepare("INSERT INTO chat_history (customer_phone, role, content) VALUES (?, 'assistant', ?)").bind(userId, botReplyText).run();
  return botReplyText;
}