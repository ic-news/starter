import {
  composeContext,
  elizaLogger,
  generateMessageResponse,
  generateText,
  messageCompletionFooter,
  ModelClass,
  ServiceType,
  stringToUuid,
} from "@elizaos/core";
import { SearchMode } from "agent-twitter-client";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";
export const twitterSearchTemplate =
  `{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{postDirections}}

{{recentPosts}}

# Task: Respond to the following post in the style and perspective of {{agentName}} (aka @{{twitterUserName}}). Write a {{adjective}} response for {{agentName}} to say directly in response to the post. don't generalize.
{{currentPost}}

IMPORTANT: Your response CANNOT be longer than 20 words.
Aim for 1-2 short sentences maximum. Be concise and direct.

Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.

` + messageCompletionFooter;
export class TwitterSearchClient {
  client;
  runtime;
  twitterUsername;
  respondedTweets = /* @__PURE__ */ new Set();
  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
  }
  async start() {
    this.engageWithSearchTermsLoop();
  }
  engageWithSearchTermsLoop() {
    this.engageWithSearchTerms().then();
    const randomMinutes = Math.floor(Math.random() * (120 - 60 + 1)) + 60;
    elizaLogger.log(`Next twitter search scheduled in ${randomMinutes} minutes`);
    setTimeout(() => this.engageWithSearchTermsLoop(), randomMinutes * 60 * 1e3);
  }
  async engageWithSearchTerms() {
    elizaLogger.log("Engaging with search terms");
    try {
      const searchTerm = [...this.runtime.character.topics][
        Math.floor(Math.random() * this.runtime.character.topics.length)
      ];
      elizaLogger.log("Fetching search tweets");
      await new Promise((resolve) => setTimeout(resolve, 5e3));
      const recentTweets = await this.client.fetchSearchTweets(searchTerm, 20, SearchMode.Top);
      elizaLogger.log("Search tweets fetched");
      const homeTimeline = await this.client.fetchHomeTimeline(50);
      await this.client.cacheTimeline(homeTimeline);
      const formattedHomeTimeline =
        `# ${this.runtime.character.name}'s Home Timeline

` +
        homeTimeline
          .map((tweet) => {
            return `ID: ${tweet.id}
From: ${tweet.name} (@${tweet.username})${
              tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""
            }
Text: ${tweet.text}
---
`;
          })
          .join("\n");
      const slicedTweets = recentTweets.tweets.sort(() => Math.random() - 0.5).slice(0, 20);
      if (slicedTweets.length === 0) {
        elizaLogger.log("No valid tweets found for the search term", searchTerm);
        return;
      }
      const prompt = `
  Here are some tweets related to the search term "${searchTerm}":

  ${[...slicedTweets, ...homeTimeline]
    .filter((tweet) => {
      const thread = tweet.thread;
      const botTweet = thread.find((t) => t.username === this.twitterUsername);
      return !botTweet;
    })
    .map(
      (tweet) => `
    ID: ${tweet.id}${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}
    From: ${tweet.name} (@${tweet.username})
    Text: ${tweet.text}
  `
    )
    .join("\n")}

  Which tweet is the most interesting and relevant for Ruby to reply to? Please provide only the ID of the tweet in your response.
  Notes:
    - Respond to English tweets only
    - Respond to tweets that don't have a lot of hashtags, links, URLs or images
    - Respond to tweets that are not retweets
    - Respond to tweets where there is an easy exchange of ideas to have with the user
    - ONLY respond with the ID of the tweet`;
      const mostInterestingTweetResponse = await generateText({
        runtime: this.runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
      });
      const tweetId = mostInterestingTweetResponse.trim();
      const selectedTweet = slicedTweets.find(
        (tweet) => tweet.id.toString().includes(tweetId) || tweetId.includes(tweet.id.toString())
      );
      if (!selectedTweet) {
        elizaLogger.warn("No matching tweet found for the selected ID");
        elizaLogger.log("Selected tweet ID:", tweetId);
        return;
      }
      elizaLogger.log("Selected tweet to reply to:", selectedTweet?.text);
      if (selectedTweet.username === this.twitterUsername) {
        elizaLogger.log("Skipping tweet from bot itself");
        return;
      }
      const conversationId = selectedTweet.conversationId;
      const roomId = stringToUuid(conversationId + "-" + this.runtime.agentId);
      const userIdUUID = stringToUuid(selectedTweet.userId);
      await this.runtime.ensureConnection(
        userIdUUID,
        roomId,
        selectedTweet.username,
        selectedTweet.name,
        "twitter"
      );
      await buildConversationThread(selectedTweet, this.client);
      const message = {
        id: stringToUuid(selectedTweet.id + "-" + this.runtime.agentId),
        agentId: this.runtime.agentId,
        content: {
          text: selectedTweet.text,
          url: selectedTweet.permanentUrl,
          inReplyTo: selectedTweet.inReplyToStatusId
            ? stringToUuid(selectedTweet.inReplyToStatusId + "-" + this.runtime.agentId)
            : void 0,
        },
        userId: userIdUUID,
        roomId,
        // Timestamps are in seconds, but we need them in milliseconds
        createdAt: selectedTweet.timestamp * 1e3,
      };
      if (!message.content.text) {
        elizaLogger.warn("Returning: No response text found");
        return;
      }
      const replies = selectedTweet.thread;
      const replyContext = replies
        .filter((reply) => reply.username !== this.twitterUsername)
        .map((reply) => `@${reply.username}: ${reply.text}`)
        .join("\n");
      let tweetBackground = "";
      if (selectedTweet.isRetweet) {
        const originalTweet = await this.client.requestQueue.add(() =>
          this.client.twitterClient.getTweet(selectedTweet.id)
        );
        tweetBackground = `Retweeting @${originalTweet.username}: ${originalTweet.text}`;
      }
      const imageDescriptions = [];
      for (const photo of selectedTweet.photos) {
        const description = await this.runtime
          .getService(ServiceType.IMAGE_DESCRIPTION)
          .describeImage(photo.url);
        imageDescriptions.push(description);
      }
      let state = await this.runtime.composeState(message, {
        twitterClient: this.client.twitterClient,
        twitterUserName: this.twitterUsername,
        timeline: formattedHomeTimeline,
        tweetContext: `${tweetBackground}

  Original Post:
  By @${selectedTweet.username}
  ${selectedTweet.text}${
          replyContext.length > 0 &&
          `
Replies to original post:
${replyContext}`
        }
  ${`Original post text: ${selectedTweet.text}`}
  ${
    selectedTweet.urls.length > 0
      ? `URLs: ${selectedTweet.urls.join(", ")}
`
      : ""
  }${
          imageDescriptions.length > 0
            ? `
Images in Post (Described): ${imageDescriptions.join(", ")}
`
            : ""
        }
  `,
      });
      await this.client.saveRequestMessage(message, state);
      const context = composeContext({
        state,
        template: this.runtime.character.templates?.twitterSearchTemplate || twitterSearchTemplate,
      });
      const responseContent = await generateMessageResponse({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.LARGE,
      });
      responseContent.inReplyTo = message.id;
      const response = responseContent;
      if (!response.text) {
        elizaLogger.warn("Returning: No response text found");
        return;
      }
      elizaLogger.log(`Bot would respond to tweet ${selectedTweet.id} with: ${response.text}`);
      try {
        const callback = async (response2) => {
          const memories = await sendTweet(
            this.client,
            response2,
            message.roomId,
            this.twitterUsername,
            selectedTweet.id
          );
          return memories;
        };
        const responseMessages = await callback(responseContent);
        state = await this.runtime.updateRecentMessageState(state);
        for (const responseMessage of responseMessages) {
          await this.runtime.messageManager.createMemory(responseMessage, false);
        }
        state = await this.runtime.updateRecentMessageState(state);
        await this.runtime.evaluate(message, state);
        await this.runtime.processActions(message, responseMessages, state, callback);
        this.respondedTweets.add(selectedTweet.id);
        const responseInfo = `Context:

${context}

Selected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}
Agent's Output:
${response.text}`;
        await this.runtime.cacheManager.set(
          `twitter/tweet_generation_${selectedTweet.id}.txt`,
          responseInfo
        );
        await wait();
      } catch (error) {
        console.error(`Error sending response post: ${error}`);
      }
    } catch (error) {
      console.error("Error engaging with search terms:", error);
    }
  }
}
