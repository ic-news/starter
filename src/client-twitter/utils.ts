import { elizaLogger, getEmbeddingZeroVector, stringToUuid } from "@elizaos/core";
import fs from "fs";
import path from "path";
export const wait = (minTime = 1e3, maxTime = 3e3) => {
  const waitTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};
export async function buildConversationThread(tweet, client, maxReplies = 10) {
  const thread = [];
  const visited = /* @__PURE__ */ new Set();
  async function processThread(currentTweet, depth = 0) {
    elizaLogger.debug("Processing tweet:", {
      id: currentTweet.id,
      inReplyToStatusId: currentTweet.inReplyToStatusId,
      depth,
    });
    if (!currentTweet) {
      elizaLogger.debug("No current tweet found for thread building");
      return;
    }
    if (depth >= maxReplies) {
      elizaLogger.debug("Reached maximum reply depth", depth);
      return;
    }
    const memory = await client.runtime.messageManager.getMemoryById(
      stringToUuid(currentTweet.id + "-" + client.runtime.agentId)
    );
    if (!memory) {
      const roomId = stringToUuid(currentTweet.conversationId + "-" + client.runtime.agentId);
      const userId = stringToUuid(currentTweet.userId);
      await client.runtime.ensureConnection(
        userId,
        roomId,
        currentTweet.username,
        currentTweet.name,
        "twitter"
      );
      await client.runtime.messageManager.createMemory({
        id: stringToUuid(currentTweet.id + "-" + client.runtime.agentId),
        agentId: client.runtime.agentId,
        content: {
          text: currentTweet.text,
          source: "twitter",
          url: currentTweet.permanentUrl,
          inReplyTo: currentTweet.inReplyToStatusId
            ? stringToUuid(currentTweet.inReplyToStatusId + "-" + client.runtime.agentId)
            : void 0,
        },
        createdAt: currentTweet.timestamp * 1e3,
        roomId,
        userId:
          currentTweet.userId === client.profile.id
            ? client.runtime.agentId
            : stringToUuid(currentTweet.userId),
        embedding: getEmbeddingZeroVector(),
      });
    }
    if (visited.has(currentTweet.id)) {
      elizaLogger.debug("Already visited tweet:", currentTweet.id);
      return;
    }
    visited.add(currentTweet.id);
    thread.unshift(currentTweet);
    elizaLogger.debug("Current thread state:", {
      length: thread.length,
      currentDepth: depth,
      tweetId: currentTweet.id,
    });
    if (currentTweet.inReplyToStatusId) {
      elizaLogger.debug("Fetching parent tweet:", currentTweet.inReplyToStatusId);
      try {
        const parentTweet = await client.twitterClient.getTweet(currentTweet.inReplyToStatusId);
        if (parentTweet) {
          elizaLogger.debug("Found parent tweet:", {
            id: parentTweet.id,
            text: parentTweet.text?.slice(0, 50),
          });
          await processThread(parentTweet, depth + 1);
        } else {
          elizaLogger.debug("No parent tweet found for:", currentTweet.inReplyToStatusId);
        }
      } catch (error) {
        elizaLogger.error("Error fetching parent tweet:", {
          tweetId: currentTweet.inReplyToStatusId,
          error,
        });
      }
    } else {
      elizaLogger.debug("Reached end of reply chain at:", currentTweet.id);
    }
  }
  await processThread(tweet, 0);
  elizaLogger.debug("Final thread built:", {
    totalTweets: thread.length,
    tweetIds: thread.map((t) => ({
      id: t.id,
      text: t.text?.slice(0, 50),
    })),
  });
  return thread;
}
export async function fetchMediaData(attachments) {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (/^(http|https):\/\//.test(attachment.url)) {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${attachment.url}`);
        }
        const mediaBuffer = Buffer.from(await response.arrayBuffer());
        const mediaType = attachment.contentType;
        return { data: mediaBuffer, mediaType };
      } else if (fs.existsSync(attachment.url)) {
        const mediaBuffer = await fs.promises.readFile(path.resolve(attachment.url));
        const mediaType = attachment.contentType;
        return { data: mediaBuffer, mediaType };
      } else {
        throw new Error(`File not found: ${attachment.url}. Make sure the path is correct.`);
      }
    })
  );
}
export async function sendTweet(client, content, roomId, twitterUsername, inReplyTo?) {
  const maxTweetLength = client.twitterConfig.MAX_TWEET_LENGTH;
  const isLongTweet = maxTweetLength > 280;
  const tweetChunks = splitTweetContent(content.text, maxTweetLength);
  const sentTweets = [];
  let previousTweetId = inReplyTo;
  for (const chunk of tweetChunks) {
    let mediaData = null;
    if (content.attachments && content.attachments.length > 0) {
      mediaData = await fetchMediaData(content.attachments);
    }
    const cleanChunk = deduplicateMentions(chunk.trim());
    const result = await client.requestQueue.add(async () =>
      isLongTweet
        ? client.twitterClient.sendLongTweet(cleanChunk, previousTweetId, mediaData)
        : client.twitterClient.sendTweet(cleanChunk, previousTweetId, mediaData)
    );
    const body = await result.json();
    const tweetResult = isLongTweet
      ? body?.data?.notetweet_create?.tweet_results?.result
      : body?.data?.create_tweet?.tweet_results?.result;
    if (tweetResult) {
      const finalTweet = {
        id: tweetResult.rest_id,
        text: tweetResult.legacy.full_text,
        conversationId: tweetResult.legacy.conversation_id_str,
        timestamp: new Date(tweetResult.legacy.created_at).getTime() / 1e3,
        userId: tweetResult.legacy.user_id_str,
        inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
        permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
        hashtags: [],
        mentions: [],
        photos: [],
        thread: [],
        urls: [],
        videos: [],
      };
      sentTweets.push(finalTweet);
      previousTweetId = finalTweet.id;
    } else {
      elizaLogger.error("sendTweet: Error sending tweet chunk:", {
        chunk,
        response: body,
      });
    }
    await wait(1e3, 2e3);
  }
  const memories = sentTweets.map((tweet) => ({
    id: stringToUuid(tweet.id + "-" + client.runtime.agentId),
    agentId: client.runtime.agentId,
    userId: client.runtime.agentId,
    content: {
      tweetId: tweet.id,
      text: tweet.text,
      source: "twitter",
      url: tweet.permanentUrl,
      inReplyTo: tweet.inReplyToStatusId
        ? stringToUuid(tweet.inReplyToStatusId + "-" + client.runtime.agentId)
        : void 0,
      action: undefined,
    },
    roomId,
    embedding: getEmbeddingZeroVector(),
    createdAt: tweet.timestamp * 1e3,
  }));
  return memories;
}
export function splitTweetContent(content, maxLength) {
  const paragraphs = content.split("\n\n").map((p) => p.trim());
  const tweets = [];
  let currentTweet = "";
  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    if ((currentTweet + "\n\n" + paragraph).trim().length <= maxLength) {
      if (currentTweet) {
        currentTweet += "\n\n" + paragraph;
      } else {
        currentTweet = paragraph;
      }
    } else {
      if (currentTweet) {
        tweets.push(currentTweet.trim());
      }
      if (paragraph.length <= maxLength) {
        currentTweet = paragraph;
      } else {
        const chunks = splitParagraph(paragraph, maxLength);
        tweets.push(...chunks.slice(0, -1));
        currentTweet = chunks[chunks.length - 1];
      }
    }
  }
  if (currentTweet) {
    tweets.push(currentTweet.trim());
  }
  return tweets;
}
export function extractUrls(paragraph) {
  const urlRegex = /https?:\/\/[^\s]+/g;
  const placeholderMap = /* @__PURE__ */ new Map();
  let urlIndex = 0;
  const textWithPlaceholders = paragraph.replace(urlRegex, (match) => {
    const placeholder = `<<URL_CONSIDERER_23_${urlIndex}>>`;
    placeholderMap.set(placeholder, match);
    urlIndex++;
    return placeholder;
  });
  return { textWithPlaceholders, placeholderMap };
}
export function splitSentencesAndWords(text, maxLength) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let currentChunk = "";
  for (const sentence of sentences) {
    if ((currentChunk + " " + sentence).trim().length <= maxLength) {
      if (currentChunk) {
        currentChunk += " " + sentence;
      } else {
        currentChunk = sentence;
      }
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      if (sentence.length <= maxLength) {
        currentChunk = sentence;
      } else {
        const words = sentence.split(" ");
        currentChunk = "";
        for (const word of words) {
          if ((currentChunk + " " + word).trim().length <= maxLength) {
            if (currentChunk) {
              currentChunk += " " + word;
            } else {
              currentChunk = word;
            }
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = word;
          }
        }
      }
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}
export function deduplicateMentions(paragraph) {
  const mentionRegex = /^@(\w+)(?:\s+@(\w+))*(\s+|$)/;
  const matches = paragraph.match(mentionRegex);
  if (!matches) {
    return paragraph;
  }
  let mentions = matches.slice(0, 1)[0].trim().split(" ");
  mentions = [...new Set(mentions)];
  const uniqueMentionsString = mentions.join(" ");
  const endOfMentions = paragraph.indexOf(matches[0]) + matches[0].length;
  return uniqueMentionsString + " " + paragraph.slice(endOfMentions);
}
export function restoreUrls(chunks, placeholderMap) {
  return chunks.map((chunk) => {
    return chunk.replace(/<<URL_CONSIDERER_23_(\d+)>>/g, (match) => {
      const original = placeholderMap.get(match);
      return original || match;
    });
  });
}
export function splitParagraph(paragraph, maxLength) {
  const { textWithPlaceholders, placeholderMap } = extractUrls(paragraph);
  const splittedChunks = splitSentencesAndWords(textWithPlaceholders, maxLength);
  const restoredChunks = restoreUrls(splittedChunks, placeholderMap);
  return restoredChunks;
}
