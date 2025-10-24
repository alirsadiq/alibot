import { InteractionType, InteractionResponseType } from 'discord-interactions';
import {
  APIMessage,
  APIChannel,
  APIInteraction,
  APIApplicationCommandInteractionDataOption,
  ChannelType,
  APIUser
} from 'discord-api-types/v10';

interface Env {
  DISCORD_TOKEN: string;
  GUILD_ID: string;
  DEFAULT_CHANNEL: string;
  OLLAMA_HOST: string;
  OLLAMA_MODEL: string;
  OPENAI_API_KEY: string;
  DB: D1Database;
}
// ---------- Normalizer ----------
type NormalizedMsg = {
  author_username: string;
  content: string;     // compact textual summary of the message
  timestamp: string;
  reactions?: Array<{ emoji_name: string; count: number }>;
};

function normalizeDiscordMessage(msg: any): NormalizedMsg {
  const bits: string[] = [];

  // 1) text content
  if (typeof msg.content === "string" && msg.content.trim()) {
    bits.push(msg.content.trim());
  }

  // 2) reply context
  if (msg.referenced_message) {
    const rm = msg.referenced_message;
    const refAuthor = rm?.author?.username || "someone";
    const refText =
      typeof rm?.content === "string" && rm.content.trim()
        ? rm.content.trim().slice(0, 120)
        : (Array.isArray(rm?.attachments) && rm.attachments.length
            ? `[attachments:${rm.attachments.length}]`
            : (Array.isArray(rm?.embeds) && rm.embeds.length
                ? `[embeds:${rm.embeds.length}]`
                : "(non-text)"));
    bits.push(`[reply → *${refAuthor}*: ${refText}]`);
  }

  // 3) attachments (images/files)
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    const att = msg.attachments
      .slice(0, 3)
      .map((a: any) => a.filename || (a.url?.split("/").pop() ?? "file"))
      .join(", ");
    bits.push(`[attachments: ${att}]`);
  }

  // 4) embeds (Tenor GIFs, link previews)
  if (Array.isArray(msg.embeds) && msg.embeds.length) {
    const titles = msg.embeds
      .map((e: any) => e.title || e.description || e.url)
      .filter(Boolean)
      .slice(0, 2);
    if (titles.length) bits.push(`[embeds: ${titles.join(" | ")}]`);
  }

  // 5) stickers
  const stickers = Array.isArray(msg.sticker_items) ? msg.sticker_items
                  : Array.isArray(msg.stickers) ? msg.stickers : [];
  if (stickers.length) {
    bits.push(`[stickers: ${stickers.map((s: any) => s.name).join(", ")}]`);
  }

  // 6) reactions
  if (Array.isArray(msg.reactions) && msg.reactions.length) {
    const reacts = msg.reactions
      .map((r: any) => {
        const n = r.count ?? 0;
        const name = r.emoji?.id
          ? `<:${r.emoji?.name}:${r.emoji?.id}>`
          : (r.emoji?.name ?? "emoji");
        return `${name}×${n}`;
      })
      .join(" ");
    bits.push(`[reactions: ${reacts}]`);
  }

  if (bits.length === 0) bits.push("(non-text post)");

  return {
    author_username: msg.author?.username ?? "unknown",
    content: bits.join(" · "),
    timestamp: msg.timestamp,
    reactions: Array.isArray(msg.reactions)
      ? msg.reactions.map((r: any) => ({
          emoji_name: r.emoji?.name ?? "emoji",
          count: r.count ?? 0,
        }))
      : undefined,
  };
}
// ---------- /Normalizer ----------
// Use Discord API types from the official package
type DiscordMessage = APIMessage;
type DiscordChannel = APIChannel;
type DiscordInteraction = APIInteraction;

interface OllamaResponse {
  response: string;
}

interface OpenAIResponse {
  choices: {
    message: {
      content: string;
    };
  }[];
}

interface OpenAIResponsesAPIResponse {
  output: {
    content: {
      type: string;
      text: string;
    }[];
  }[];
}

interface MessageText {
  author_username: string;
  content: string;
  reactions?: { emoji_name: string; count: number }[];
  timestamp: string;
}

interface MessageWithImages {
  author_username: string;
  content: string;
  reactions?: { emoji_name: string; count: number }[];
  timestamp: string;
  image_urls?: string[];
  image_descriptions?: string[];
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    console.log(`[WORKER] Incoming request: ${request.method} ${url.pathname}`);
    console.log(`[WORKER] Environment check - DISCORD_TOKEN: ${env.DISCORD_TOKEN ? 'Present' : 'Missing'}, OPENAI_API_KEY: ${env.OPENAI_API_KEY ? 'Present' : 'Missing'}`);

    if (request.method === 'POST' && url.pathname === '/interactions') {
      console.log('[WORKER] Handling Discord interaction');
      return handleDiscordInteraction(request, env);
    }

    if (url.pathname === '/summarize') {
      const channelName = url.searchParams.get('channel') || env.DEFAULT_CHANNEL;
      const send = url.searchParams.get('send');
      console.log(`[WORKER] Summarize request - Channel: ${channelName}, Send: ${send}`);
      
      let summaryResult: { summary: string; oldestMessageTimestamp: string | null; newestMessageTimestamp: string | null; messageCount: number };
      try {
        summaryResult = await generateChannelSummary(channelName, env);
        console.log(`[WORKER] Summary generated successfully, length: ${summaryResult.summary.length}`);
      } catch (error) {
        console.error('[WORKER] Error generating summary:', error);
        throw error;
      }

      if (send === '1') {
        try {
          await sendSummaryToChannel(summaryResult.summary, '', env);
          return new Response(JSON.stringify({
            channel: channelName,
            summary: summaryResult.summary,
            sent_to: '',
            timestamp: new Date().toISOString(),
            oldestMessageTimestamp: summaryResult.oldestMessageTimestamp,
            newestMessageTimestamp: summaryResult.newestMessageTimestamp,
            messageCount: summaryResult.messageCount
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          return new Response(JSON.stringify({
            channel: channelName,
            summary: summaryResult.summary,
            error: errorMessage,
            timestamp: new Date().toISOString(),
            oldestMessageTimestamp: summaryResult.oldestMessageTimestamp,
            newestMessageTimestamp: summaryResult.newestMessageTimestamp,
            messageCount: summaryResult.messageCount
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      return new Response(JSON.stringify({
        channel: channelName,
        summary: summaryResult.summary,
        timestamp: new Date().toISOString(),
        oldestMessageTimestamp: summaryResult.oldestMessageTimestamp,
        newestMessageTimestamp: summaryResult.newestMessageTimestamp,
        messageCount: summaryResult.messageCount
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Discord Summarizer Bot', { status: 200 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduledSummary(env));
  }
};

async function handleDiscordInteraction(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any; // Use any for now to handle type conflicts

    if (body.type === InteractionType.PING) {
      console.log('are we here')
const resp =  new Response('{"type":1}', {
  status: 200,
  headers: { "Content-Type": "application/json" }
});
console.log(resp)
return resp;
    }

    if (body.type === InteractionType.APPLICATION_COMMAND) {
      if (body.data?.name === 'summarize') {
        const channelName = body.data.options?.[0]?.value || 'dreams';
        const summaryResult = await generateChannelSummary(channelName, env);

        return new Response(JSON.stringify({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: summaryResult.summary
          }
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Unknown interaction', { status: 400 });
  } catch (error) {
    console.error('Error handling interaction:', error);
    return new Response('Internal error', { status: 500 });
  }
}

async function handleScheduledSummary(env: Env): Promise<void> {
  try {
    const defaultChannel = env.DEFAULT_CHANNEL || 'dreams';
    const summaryResult = await generateChannelSummary(defaultChannel, env);
    await sendSummaryToChannel(summaryResult.summary, 'aliboy', env);
  } catch (error) {
    console.error('Error in scheduled summary:', error);
  }
}

async function generateChannelSummary(channelName: string, env: Env): Promise<{
  summary: string;
  oldestMessageTimestamp: string | null;
  newestMessageTimestamp: string | null;
  messageCount: number;
}> {
  console.log(`[SUMMARY] Starting summary generation for channel: ${channelName}`);
  try {
    console.log(`[SUMMARY] Fetching messages for channel: ${channelName}`);
    const messages = await fetchChannelMessages(channelName, env);
    console.log(`[SUMMARY] Fetched ${messages.length} messages from #${channelName}`);

    if (messages.length === 0) {
      console.log(`[SUMMARY] No messages found in #${channelName}`);
      return {
        summary: `No messages found in #${channelName} in the last 24 hours.`,
        oldestMessageTimestamp: null,
        newestMessageTimestamp: null,
        messageCount: 0
      };
    }

    console.log(`[SUMMARY] Processing ${messages.length} messages for summarization`);
    const summary = await summarizeMessages(messages, env);
    console.log(`[SUMMARY] Summary completed, length: ${summary.length} characters`);
    
    // Messages are now in oldest-first order after the reverse
    const oldestMessage = messages[0];
    const newestMessage = messages[messages.length - 1];
    
    return {
      summary: `📊 **Daily Summary for #${channelName}**\n\n${summary}`,
      oldestMessageTimestamp: oldestMessage?.timestamp || null,
      newestMessageTimestamp: newestMessage?.timestamp || null,
      messageCount: messages.length
    };
  } catch (error) {
    console.error('[SUMMARY] Error generating summary:', error);
    console.error('[SUMMARY] Error details:', error instanceof Error ? error.message : String(error));
    return {
      summary: `Sorry, I couldn't generate a summary for #${channelName} due to an error.`,
      oldestMessageTimestamp: null,
      newestMessageTimestamp: null,
      messageCount: 0
    };
  }
}

async function fetchChannelMessages(channelName: string, env: Env): Promise<DiscordMessage[]> {
  console.log(`[FETCH] Starting message fetch for channel: ${channelName}`);
  console.log(`[FETCH] Guild ID: ${env.GUILD_ID}`);
  
  // Validate Discord token format
  if (!env.DISCORD_TOKEN) {
    throw new Error("Missing DISCORD_TOKEN");
  }
  
  const channelId = await getChannelId(channelName, env);
  if (!channelId) {
    console.error(`[FETCH] Channel #${channelName} not found`);
    throw new Error(`Channel #${channelName} not found`);
  }
  console.log(`[FETCH] Found channel ID: ${channelId}`);

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  console.log(`[FETCH] Filtering messages after: ${yesterday.toISOString()}`);
  
  const allMessages: DiscordMessage[] = [];
  let lastMessageId: string | undefined;
  const maxMessages = 1000;
  const batchSize = 100; // Discord API limit per request

  console.log(`[FETCH] Fetching up to ${maxMessages} messages from the last 24 hours`);

  while (allMessages.length < maxMessages) {
    // Build URL with pagination
    let url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${batchSize}`;
    if (lastMessageId) {
      url += `&before=${lastMessageId}`;
      console.log(`[FETCH] Fetching batch before message ID: ${lastMessageId}`);
    } else {
      console.log(`[FETCH] Fetching first batch of messages`);
    }

    console.log(`[FETCH] Making Discord API call to: ${url}`);
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bot ${env.DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (discord-summarizer, 1.0.0)'
      }
    });

    console.log(`[FETCH] Discord API response status: ${response.status}`);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[FETCH] Discord API error: ${response.status} - ${errorText}`);
      throw new Error(`Failed to fetch messages: ${response.status} - ${errorText}`);
    }

    const messages = await response.json() as DiscordMessage[];
    console.log(`[FETCH] Received ${messages.length} messages from Discord API`);
    //console.log(`[FETCH] Messages received:`, JSON.stringify(messages, null, 2 ));
    
    if (messages.length === 0) {
      console.log('[FETCH] No more messages available, ending pagination');
      break; // No more messages
    }

// keep last 24h & ignore bot authors
const recentMessages = messages.filter(m => {
  const ts = new Date(m.timestamp);
  return ts >= yesterday && !m.author?.bot;
});

    // If we find messages older than 24 hours, we can stop
    const oldMessages = messages.filter(message => {
      const messageDate = new Date(message.timestamp);
      return messageDate < yesterday;
    });

    console.log(`[FETCH] Filtered messages: ${recentMessages.length} recent, ${oldMessages.length} old`);
    allMessages.push(...recentMessages);
    
    if (oldMessages.length > 0) {
      console.log(`[FETCH] Reached messages older than 24 hours, stopping pagination`);
      break; // We've gone past the 24-hour window
    }

    // Set up for next iteration
    lastMessageId = messages[messages.length - 1]?.id;
    
    console.log(`[FETCH] Batch complete: ${messages.length} fetched, ${recentMessages.length} added, total: ${allMessages.length}`);
  }

  console.log(`Total messages fetched from last 24 hours: ${allMessages.length}`);
  // Reverse to get oldest-first order (Discord API returns newest-first)
  return allMessages.reverse();
}

async function getChannelId(channelName: string, env: Env): Promise<string | undefined> {
  console.log(`[CHANNEL] Looking up channel: ${channelName} in guild: ${env.GUILD_ID}`);
  console.log(`[CHANNEL] Discord token present: ${env.DISCORD_TOKEN ? 'Yes' : 'No'}`);
  console.log(`[CHANNEL] Discord token length: ${env.DISCORD_TOKEN?.length || 0}`);
  
  const url = `https://discord.com/api/v10/guilds/${env.GUILD_ID}/channels`;
  console.log(`[CHANNEL] Fetching from: ${url}`);
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bot ${env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DiscordBot (discord-summarizer, 1.0.0)'
    }
  });

  console.log(`[CHANNEL] Discord channels API response status: ${response.status}`);
  console.log(`[CHANNEL] Response headers:`, Object.fromEntries(response.headers.entries()));
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[CHANNEL] Discord channels API error: ${response.status} - ${errorText}`);
    throw new Error(`Failed to fetch channels: ${response.status} - ${errorText}`);
  }

  const channels = await response.json() as DiscordChannel[];
  console.log(`[CHANNEL] Found ${channels.length} channels in guild`);
  console.log(`[CHANNEL] Available channels:`, channels.map(ch => `${ch.name} (${ch.type})`));
  
  const channel = channels.find(ch => ch.name === channelName && ch.type === ChannelType.GuildText);
  
  if (channel) {
    console.log(`[CHANNEL] Found target channel: ${channelName} with ID: ${channel.id}`);
  } else {
    console.error(`[CHANNEL] Channel '${channelName}' not found. Available text channels:`, 
      channels.filter(ch => ch.type === ChannelType.GuildText).map(ch => ch.name));
  }

  return channel?.id;
}

// Helper function to convert ArrayBuffer to base64 without call stack issues
async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192; // Process in chunks to avoid call stack limit
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }

  return btoa(binary);
}

// Helper function to resize image if needed (using Canvas API in Cloudflare Workers)
async function resizeImageIfNeeded(imageBuffer: ArrayBuffer, maxWidth: number = 800, maxHeight: number = 600): Promise<ArrayBuffer> {
  // For now, just return the original buffer
  // In a full implementation, you could use a library like sharp or canvas to resize
  // But Cloudflare Workers has limited image processing capabilities

  // If image is too large (>2MB), we'll skip processing to avoid memory issues
  if (imageBuffer.byteLength > 2 * 1024 * 1024) {
    throw new Error('Image too large for processing');
  }

  return imageBuffer;
}

async function summarizeMessages(messages: DiscordMessage[], env: Env): Promise<string> {
  const uniqueUsers = new Set(messages.map(m => m.author.username)).size;
  console.log(`[SUMMARIZE] Starting summarization of ${messages.length} messages from ${uniqueUsers} users`);
  
  if (!env.OPENAI_API_KEY) {
    console.log(`[SUMMARIZE] Missing OpenAI API key, returning basic stats`);
    return `Found ${messages.length} messages from ${uniqueUsers} users.`;
  }

  if (messages.length < 5) {
    console.log(`[SUMMARIZE] Too few messages (${messages.length}), skipping AI summarization`);
    return `Found only ${messages.length} messages from ${uniqueUsers} users. Not enough data to summarize.`;
  }

  try {
    // Step 1: Extract and process all images
    console.log(`[SUMMARIZE] Step 1: Extracting and processing images`);
    const { imageAttachments, messagesWithImageIndices } = await extractAndProcessImages(messages);
    console.log(`[SUMMARIZE] Found ${imageAttachments.length} images across ${messagesWithImageIndices.length} processed messages`);

    // Step 2: Get image descriptions from OpenAI
    console.log(`[SUMMARIZE] Step 2: Getting image descriptions`);
    const imageDescriptions = await getImageDescriptions(imageAttachments, env);
    console.log(`[SUMMARIZE] Generated descriptions for ${Object.keys(imageDescriptions).length} images`);

    // Step 3: Create final messages with image descriptions
    console.log(`[SUMMARIZE] Step 3: Creating final messages with image descriptions`);
    const finalMessages = createMessagesWithImageDescriptions(messagesWithImageIndices, imageDescriptions);

    // Step 4: Generate summary
    console.log(`[SUMMARIZE] Step 4: Generating AI summary`);
    return await generateSummary(finalMessages, env);
  } catch (error) {
    console.error(`[SUMMARIZE] Error during summarization:`, error);
    console.error(`[SUMMARIZE] Error details:`, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function extractAndProcessImages(messages: DiscordMessage[]): Promise<{
  imageAttachments: { id: string; url: string }[];
  messagesWithImageIndices: MessageWithImages[];
}> {
  console.log(`[IMAGES] Starting image extraction from ${messages.length} messages`);
  const imageAttachments: { id: string; url: string }[] = [];
  const messagesWithImageIndices: MessageWithImages[] = [];
  let totalImages = 0;

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex];
    if (!msg) {
      console.log(`[IMAGES] Skipping undefined message at index ${msgIndex}`);
      continue; // Skip if message is undefined or null
    }
    const messageImageUrls: string[] = [];

    // Process image attachments for this message
    if (msg.attachments && msg.attachments.length > 0) {
      console.log(`[IMAGES] Processing ${msg.attachments.length} attachments for message ${msgIndex} by ${msg.author.username}`);
      for (const attachment of msg.attachments) {
        if (attachment.content_type?.startsWith('image/')) {
          // Use Discord's proxy URL with 256x256 size parameter
          const resizedUrl = attachment.proxy_url ?
            `${attachment.proxy_url}?width=256&height=256` :
            `${attachment.url}?width=256&height=256`;

          imageAttachments.push({ id: attachment.id, url: resizedUrl });
          messageImageUrls.push(attachment.id);
          totalImages++;

          console.log(`[IMAGES] Added image URL from message ${msgIndex}: ${attachment.filename} (${attachment.content_type})`);
        } else {
          console.log(`[IMAGES] Skipping non-image attachment: ${attachment.filename} (${attachment.content_type})`);
        }
      }
    }

    // Create message with image URLs (but no modified content yet)
    messagesWithImageIndices.push({
      author_username: msg.author.username,
      content: msg.content,
      reactions: msg.reactions ? msg.reactions.map(r => ({ emoji_name: r.emoji.name || "unrecognized", count: r.count })) : undefined,
      timestamp: msg.timestamp,
      image_urls: messageImageUrls.length > 0 ? messageImageUrls : undefined
    });
  }

  console.log(`[IMAGES] Extraction complete: ${totalImages} images found across ${messagesWithImageIndices.length} messages`);
  return { imageAttachments, messagesWithImageIndices };
}

async function getImageDescriptions(imageAttachments: { id: string; url: string }[], env: Env): Promise<{ [key: string]: string }> {
  console.log(`[IMAGE_AI] Starting image analysis for ${imageAttachments.length} images`);
  const imageDescriptions: { [key: string]: string } = {};

  if (imageAttachments.length === 0) {
    console.log(`[IMAGE_AI] No images to analyze, returning empty descriptions`);
    return imageDescriptions;
  }

  console.log(`[IMAGE_AI] Image URLs to analyze:`, imageAttachments.map((attachment, i) => `${i}: ${attachment.url.substring(0, 100)}...`));

  // Prepare input array for OpenAI Responses API
  const input = [{
    role: "user",
    content: [
      {
        type: "input_text",
        text: "Briefly describe these images"
      },
      ...imageAttachments.map((attachment) => ({
        type: "input_image",
        detail: "low",
        image_url: attachment.url
      }))
    ]
  }];

  const imageAnalysisRequestBody = {
    model: "gpt-4.1-nano",
    input: input,
    text: {
      format: {
        type: "json_schema",
        name: "image_description_schema",
        strict: true,
        schema: {
          type: "object",
          properties: {
            image_analysis: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  image_url: {
                    type: "string",
                    description: "The URL of the image to be described."
                  },
                  image_description: {
                    type: "string",
                    description: "Description of the image in one sentence. Focus on car-related content if present."
                  }
                },
                required: [
                  "image_url",
                  "image_description"
                ],
                additionalProperties: false
              }
            }
          },
          required: [
            "image_analysis"
          ],
          additionalProperties: false
        }
      }
    },
    stream: false
  };

  try {
    console.log(`[IMAGE_AI] Sending request to OpenAI Responses API`);
    console.log(`[IMAGE_AI] Request payload size: ${JSON.stringify(imageAnalysisRequestBody).length} characters`);
    
    const imageAnalysisResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(imageAnalysisRequestBody)
    });

    console.log(`[IMAGE_AI] Request body:`, JSON.stringify(imageAnalysisRequestBody, null, 2));

    console.log(`[IMAGE_AI] OpenAI Responses API response status: ${imageAnalysisResponse.status}`);
    if (!imageAnalysisResponse.ok) {
      const errorText = await imageAnalysisResponse.text();
      console.error(`[IMAGE_AI] OpenAI Responses API error: ${imageAnalysisResponse.status} - ${errorText}`);
      return imageDescriptions;
    }

    const imageAnalysisData = await imageAnalysisResponse.json() as OpenAIResponsesAPIResponse;
    console.log('[IMAGE_AI] OpenAI Responses API response received');
    console.log('[IMAGE_AI] Full response:', imageAnalysisData);

    // Parse the structured JSON response from output[0].content[0].text
    if (imageAnalysisData.output && Array.isArray(imageAnalysisData.output) && imageAnalysisData.output.length > 0) {
      const firstOutput = imageAnalysisData.output[0];
      if (firstOutput && firstOutput.content && Array.isArray(firstOutput.content) && firstOutput.content.length > 0) {
        const textContent = firstOutput.content[0];
        if (textContent && textContent.type === 'output_text' && textContent.text) {
          try {
            // Parse the JSON schema response
            const parsedResponse = JSON.parse(textContent.text);
            if (parsedResponse.image_analysis && Array.isArray(parsedResponse.image_analysis)) {
              parsedResponse.image_analysis.forEach((imageAnalysis: any, index: number) => {
                if (imageAnalysis.image_description && index < imageAttachments.length) {
                  const attachment = imageAttachments[index];
                  if (attachment) {
                    const attachmentId = attachment.id;
                    imageDescriptions[attachmentId] = imageAnalysis.image_description;
                    console.log(`[IMAGE_AI] Mapped description for attachment ${attachmentId}: ${imageAnalysis.image_description}`);
                  }
                }
              });
            } else {
              console.warn(`[IMAGE_AI] No image_analysis array in parsed response`);
              // Fallback: create simple descriptions for each image URL
              imageAttachments.forEach((attachment) => {
                imageDescriptions[attachment.id] = 'Image description unavailable';
              });
            }
          } catch (parseError) {
            console.warn(`[IMAGE_AI] Failed to parse JSON response:`, parseError);
            // Fallback: create simple descriptions for each image URL
            imageAttachments.forEach((attachment) => {
              imageDescriptions[attachment.id] = 'Image description unavailable';
            });
          }
        }
      }
    } else {
      console.warn('[IMAGE_AI] Unexpected response format:', imageAnalysisData);
      // Fallback: create simple descriptions for each image URL
      imageAttachments.forEach((attachment) => {
        imageDescriptions[attachment.id] = 'Image description unavailable';
      });
    }
  } catch (error) {
    console.error('Failed to analyze images:', error);
  }

  return imageDescriptions;
}

function createMessagesWithImageDescriptions(
  messagesWithImageIndices: MessageWithImages[],
  imageDescriptions: { [imageUrl: string]: string }
): MessageWithImages[] {
  return messagesWithImageIndices.map(msg => {
    if (!msg.image_urls || msg.image_urls.length === 0) {
      return msg;
    }

    const descriptions = msg.image_urls.map(attachmentId => {
      const desc = imageDescriptions[attachmentId];
      return desc || '[Description not available]';
    });

    return {
      ...msg,
      image_descriptions: descriptions
    };
  });
}

async function generateSummary(finalMessages: MessageWithImages[], env: Env): Promise<string> {
  console.log(`[AI_SUMMARY] Starting summary generation for ${finalMessages.length} messages`);

  // Create clean message format for the summary
  const summaryMessages = finalMessages.map(msg => {
    const summaryMessage: any = {
      author_username: msg.author_username,
      content: msg.content,
      reactions: msg.reactions,
      timestamp: msg.timestamp
    };

    if (msg.image_descriptions && msg.image_descriptions.length > 0) {
      summaryMessage.imageContentDescriptions = msg.image_descriptions;
      console.log(`[AI_SUMMARY] Message from ${msg.author_username} includes ${msg.image_descriptions.length} image descriptions`);
    }

    return summaryMessage;
  });

  console.log(`[AI_SUMMARY] Prepared ${summaryMessages.length} messages for summarization`);

  // put each message on its own line:
  const finalMessageTextsStr = summaryMessages.map(msg => {
    return JSON.stringify( msg )
  }).join('\n');
  

  // Use a more structured prompt that Ollama will follow better
  let summaryPrompt = `ROLE: You are a witty Discord channel summarizer for a car enthusiast group.

TASK: Create a quick summary recap to your anime loving bros, add a hint of islamic banter, not boardroom briefing.
Use a humorous, light-hearted tone. Casual "bro" style - be cheeky but friendly.
Only focus on key highlights and funny moments. You can use a brief introduction, up to five bullets, and any closing witty joke. Don't need to mention every single message or detail.
Use markdown, and *italicize usernames*.
Don't mention requirements or instructions in the summary. Just respond with your recap directly.

MESSAGES TO SUMMARIZE:
${finalMessageTextsStr}

SUMMARY (follow all requirements above):`;

console.log('[AI_SUMMARY] Summary prompt length:', summaryPrompt.length);
  console.log('[AI_SUMMARY] Summary prompt preview:', summaryPrompt);
  
  const summaryRequestBody = {
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: summaryPrompt
      }
    ],
    max_tokens: 500,
    temperature: 0.7
  };
  console.log('am I here')
  console.log(`[AI_SUMMARY] Sending summary request to OpenAI`);
  console.log(`[AI_SUMMARY] Request payload size: ${JSON.stringify(summaryRequestBody).length} characters`);
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  });
  console.log(await res.text());
  const summaryResponse = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY }`
    },
    body: JSON.stringify(summaryRequestBody)
  });

  console.log(`[AI_SUMMARY] OpenAI summary API response status: ${summaryResponse.status}`);
  if (!summaryResponse.ok) {
    const errorText = await summaryResponse.text();
    console.error(`[AI_SUMMARY] OpenAI summary API error: ${summaryResponse.status} - ${errorText}`);
    throw new Error(`OpenAI summary API error: ${summaryResponse.status} - ${errorText}`);
  }

  const summaryData = await summaryResponse.json() as OpenAIResponse;
  const summaryContent = summaryData.choices[0]?.message?.content || 'Summary unavailable';
  console.log('[AI_SUMMARY] Summary response received, length:', summaryContent.length);
  console.log('[AI_SUMMARY] Summary content:', summaryContent);
  return summaryContent;
}

async function sendSummaryToChannel(summary: string, channelName: string, env: Env): Promise<any> {
  try {
    const channelId = await getChannelId(channelName, env);
    if (!channelId) {
      console.error(`Channel '${channelName}' not found`);
      throw new Error(`Channel '${channelName}' not found`);
    }

    console.log(`Sending message to channel ${channelName} (${channelId})`);

    // Truncate summary if it exceeds Discord's 2000 character limit
    let content = summary;
    if (content.length > 2000) {
      content = content.substring(0, 1950) + '...\n\n*[Summary truncated]*';
    }

    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${env.DISCORD_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: content
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to send message: ${response.status} - ${errorText}`);
      throw new Error(`Failed to send message: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { id: string };
    console.log('Message sent successfully:', result.id);
    return result;
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
}
