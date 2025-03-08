// src/interactions.ts
import {
  composeContext,
  elizaLogger,
  generateMessageResponse,
  generateShouldRespond,
  getEmbeddingZeroVector,
  messageCompletionFooter,
  ModelClass,
  ServiceType,
  shouldRespondFooter,
  stringToUuid,
} from "@elizaos/core";
import { SearchMode } from "agent-twitter-client";
import { sendTweet, wait } from "./utils.ts";

export const twitterMessageHandlerTemplate =
  `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}
` + messageCompletionFooter;
export const twitterShouldRespondTemplate = (targetUsersStr) =>
  `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;
export class TwitterInteractionClient {
  client;
  runtime;
  isDryRun;
  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
    this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
  }
  async start() {
    const handleTwitterInteractionsLoop = () => {
      this.handleTwitterInteractions();
      setTimeout(
        handleTwitterInteractionsLoop,
        // Defaults to 2 minutes
        this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1e3
      );
    };
    handleTwitterInteractionsLoop();
  }
  async handleTwitterInteractions() {
    elizaLogger.log("Checking Twitter interactions");
    const twitterUsername = this.client.profile.username;
    try {
      const mentionCandidates = (
        await this.client.fetchSearchTweets(`@${twitterUsername}`, 20, SearchMode.Latest)
      ).tweets;
      elizaLogger.log("Completed checking mentioned tweets:", mentionCandidates.length);
      let uniqueTweetCandidates = [...mentionCandidates];
      if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
        const TARGET_USERS = this.client.twitterConfig.TWITTER_TARGET_USERS;
        elizaLogger.log("Processing target users:", TARGET_USERS);
        if (TARGET_USERS.length > 0) {
          const tweetsByUser = /* @__PURE__ */ new Map();
          for (const username of TARGET_USERS) {
            try {
              const userTweets = (
                await this.client.twitterClient.fetchSearchTweets(
                  `from:${username}`,
                  3,
                  SearchMode.Latest
                )
              ).tweets;
              const validTweets = userTweets.filter((tweet) => {
                const isUnprocessed =
                  !this.client.lastCheckedTweetId ||
                  Number.parseInt(tweet.id) > this.client.lastCheckedTweetId;
                const isRecent = Date.now() - tweet.timestamp * 1e3 < 2 * 60 * 60 * 1e3;
                elizaLogger.log(`Tweet ${tweet.id} checks:`, {
                  isUnprocessed,
                  isRecent,
                  isReply: tweet.isReply,
                  isRetweet: tweet.isRetweet,
                });
                return isUnprocessed && !tweet.isReply && !tweet.isRetweet && isRecent;
              });
              if (validTweets.length > 0) {
                tweetsByUser.set(username, validTweets);
                elizaLogger.log(`Found ${validTweets.length} valid tweets from ${username}`);
              }
            } catch (error) {
              elizaLogger.error(`Error fetching tweets for ${username}:`, error);
              continue;
            }
          }
          const selectedTweets = [];
          for (const [username, tweets] of tweetsByUser) {
            if (tweets.length > 0) {
              const randomTweet = tweets[Math.floor(Math.random() * tweets.length)];
              selectedTweets.push(randomTweet);
              elizaLogger.log(
                `Selected tweet from ${username}: ${randomTweet.text?.substring(0, 100)}`
              );
            }
          }
          uniqueTweetCandidates = [...mentionCandidates, ...selectedTweets];
        }
      } else {
        elizaLogger.log("No target users configured, processing only mentions");
      }
      uniqueTweetCandidates
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((tweet) => tweet.userId !== this.client.profile.id);
      for (const tweet of uniqueTweetCandidates) {
        if (!this.client.lastCheckedTweetId || BigInt(tweet.id) > this.client.lastCheckedTweetId) {
          const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
          const existingResponse = await this.runtime.messageManager.getMemoryById(tweetId);
          if (existingResponse) {
            elizaLogger.log(`Already responded to tweet ${tweet.id}, skipping`);
            continue;
          }
          elizaLogger.log("New Tweet found", tweet.permanentUrl);
          const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);
          const userIdUUID =
            tweet.userId === this.client.profile.id
              ? this.runtime.agentId
              : stringToUuid(tweet.userId);
          await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            tweet.username,
            tweet.name,
            "twitter"
          );
          const thread = await this.buildConversationThread(tweet, this.client);
          const message = {
            content: {
              text: tweet.text,
              imageUrls: tweet.photos?.map((photo) => photo.url) || [],
            },
            agentId: this.runtime.agentId,
            userId: userIdUUID,
            roomId,
          };
          await this.handleTweet({
            tweet,
            message,
            thread,
          });
          this.client.lastCheckedTweetId = BigInt(tweet.id);
        }
      }
      await this.client.cacheLatestCheckedTweetId();
      elizaLogger.log("Finished checking Twitter interactions");
    } catch (error) {
      elizaLogger.error("Error handling Twitter interactions:", error);
    }
  }
  async handleTweet({ tweet, message, thread }) {
    if (
      tweet.userId === this.client.profile.id &&
      !this.client.twitterConfig.TWITTER_TARGET_USERS.includes(tweet.username)
    ) {
      return;
    }
    if (!message.content.text) {
      elizaLogger.log("Skipping Tweet with no text", tweet.id);
      return { text: "", action: "IGNORE" };
    }
    elizaLogger.log("Processing Tweet: ", tweet.id);
    const formatTweet = (tweet2) => {
      return `  ID: ${tweet2.id}
  From: ${tweet2.name} (@${tweet2.username})
  Text: ${tweet2.text}`;
    };
    const currentPost = formatTweet(tweet);
    const formattedConversation = thread
      .map(
        (tweet2) => `@${tweet2.username} (${new Date(tweet2.timestamp * 1e3).toLocaleString(
          "en-US",
          {
            hour: "2-digit",
            minute: "2-digit",
            month: "short",
            day: "numeric",
          }
        )}):
        ${tweet2.text}`
      )
      .join("\n\n");
    const imageDescriptionsArray = [];
    try {
      for (const photo of tweet.photos) {
        const description = await this.runtime
          .getService(ServiceType.IMAGE_DESCRIPTION)
          .describeImage(photo.url);
        imageDescriptionsArray.push(description);
      }
    } catch (error) {
      elizaLogger.error("Error Occured during describing image: ", error);
    }
    let state = await this.runtime.composeState(message, {
      twitterClient: this.client.twitterClient,
      twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
      currentPost,
      formattedConversation,
      imageDescriptions:
        imageDescriptionsArray.length > 0
          ? `
Images in Tweet:
${imageDescriptionsArray
  .map(
    (desc, i) => `Image ${i + 1}: Title: ${desc.title}
Description: ${desc.description}`
  )
  .join("\n\n")}`
          : "",
    });
    const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
    const tweetExists = await this.runtime.messageManager.getMemoryById(tweetId);
    if (!tweetExists) {
      elizaLogger.log("tweet does not exist, saving");
      const userIdUUID = stringToUuid(tweet.userId);
      const roomId = stringToUuid(tweet.conversationId);
      const message2 = {
        id: tweetId,
        agentId: this.runtime.agentId,
        content: {
          text: tweet.text,
          url: tweet.permanentUrl,
          imageUrls: tweet.photos?.map((photo) => photo.url) || [],
          inReplyTo: tweet.inReplyToStatusId
            ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
            : void 0,
        },
        userId: userIdUUID,
        roomId,
        createdAt: tweet.timestamp * 1e3,
      };
      this.client.saveRequestMessage(message2, state);
    }
    const validTargetUsersStr = this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");
    const shouldRespondContext = composeContext({
      state,
      template:
        this.runtime.character.templates?.twitterShouldRespondTemplate ||
        this.runtime.character?.templates?.shouldRespondTemplate ||
        twitterShouldRespondTemplate(validTargetUsersStr),
    });
    const shouldRespond = await generateShouldRespond({
      runtime: this.runtime,
      context: shouldRespondContext,
      modelClass: ModelClass.MEDIUM,
    });
    if (shouldRespond !== "RESPOND") {
      elizaLogger.log("Not responding to message");
      return { text: "Response Decision:", action: shouldRespond };
    }
    const context = composeContext({
      state: {
        ...state,
        // Convert actionNames array to string
        actionNames: Array.isArray(state.actionNames)
          ? state.actionNames.join(", ")
          : state.actionNames || "",
        actions: Array.isArray(state.actions) ? state.actions.join("\n") : state.actions || "",
        // Ensure character examples are included
        characterPostExamples: this.runtime.character.messageExamples
          ? this.runtime.character.messageExamples
              .map((example) =>
                example
                  .map(
                    (msg) =>
                      `${msg.user}: ${msg.content.text}${
                        msg.content.action ? ` [Action: ${msg.content.action}]` : ""
                      }`
                  )
                  .join("\n")
              )
              .join("\n\n")
          : "",
      },
      template:
        this.runtime.character.templates?.twitterMessageHandlerTemplate ||
        this.runtime.character?.templates?.messageHandlerTemplate ||
        twitterMessageHandlerTemplate,
    });
    const response = await generateMessageResponse({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.LARGE,
    });
    const removeQuotes = (str) => str.replace(/^['"](.*)['"]$/, "$1");
    const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
    response.inReplyTo = stringId;
    response.text = removeQuotes(response.text);
    if (response.text) {
      if (this.isDryRun) {
        elizaLogger.info(
          `Dry run: Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}
Agent's Output:
${response.text}`
        );
      } else {
        try {
          const callback = async (response2, tweetId2?) => {
            const memories = await sendTweet(
              this.client,
              response2,
              message.roomId,
              this.client.twitterConfig.TWITTER_USERNAME,
              tweetId2 || tweet.id
            );
            return memories;
          };
          const responseMessages = await callback(response);
          state = await this.runtime.updateRecentMessageState(state);
          for (const responseMessage of responseMessages) {
            if (responseMessage === responseMessages[responseMessages.length - 1]) {
              responseMessage.content.action = response.action;
            } else {
              responseMessage.content.action = "CONTINUE";
            }
            await this.runtime.messageManager.createMemory(responseMessage);
          }
          const responseTweetId = responseMessages[responseMessages.length - 1]?.content?.tweetId;
          await this.runtime.processActions(message, responseMessages, state, (response2) => {
            return callback(response2, responseTweetId);
          });
          const responseInfo = `Context:

${context}

Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}
Agent's Output:
${response.text}`;
          await this.runtime.cacheManager.set(
            `twitter/tweet_generation_${tweet.id}.txt`,
            responseInfo
          );
          await wait();
        } catch (error) {
          elizaLogger.error(`Error sending response tweet: ${error}`);
        }
      }
    }
  }
  async buildConversationThread(tweet, maxReplies = 10) {
    const thread = [];
    const visited = /* @__PURE__ */ new Set();
    async function processThread(currentTweet, depth = 0) {
      elizaLogger.log("Processing tweet:", {
        id: currentTweet.id,
        inReplyToStatusId: currentTweet.inReplyToStatusId,
        depth,
      });
      if (!currentTweet) {
        elizaLogger.log("No current tweet found for thread building");
        return;
      }
      if (depth >= maxReplies) {
        elizaLogger.log("Reached maximum reply depth", depth);
        return;
      }
      const memory = await this.runtime.messageManager.getMemoryById(
        stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
      );
      if (!memory) {
        const roomId = stringToUuid(currentTweet.conversationId + "-" + this.runtime.agentId);
        const userId = stringToUuid(currentTweet.userId);
        await this.runtime.ensureConnection(
          userId,
          roomId,
          currentTweet.username,
          currentTweet.name,
          "twitter"
        );
        this.runtime.messageManager.createMemory({
          id: stringToUuid(currentTweet.id + "-" + this.runtime.agentId),
          agentId: this.runtime.agentId,
          content: {
            text: currentTweet.text,
            source: "twitter",
            url: currentTweet.permanentUrl,
            imageUrls: currentTweet.photos?.map((photo) => photo.url) || [],
            inReplyTo: currentTweet.inReplyToStatusId
              ? stringToUuid(currentTweet.inReplyToStatusId + "-" + this.runtime.agentId)
              : void 0,
          },
          createdAt: currentTweet.timestamp * 1e3,
          roomId,
          userId:
            currentTweet.userId === this.twitterUserId
              ? this.runtime.agentId
              : stringToUuid(currentTweet.userId),
          embedding: getEmbeddingZeroVector(),
        });
      }
      if (visited.has(currentTweet.id)) {
        elizaLogger.log("Already visited tweet:", currentTweet.id);
        return;
      }
      visited.add(currentTweet.id);
      thread.unshift(currentTweet);
      if (currentTweet.inReplyToStatusId) {
        elizaLogger.log("Fetching parent tweet:", currentTweet.inReplyToStatusId);
        try {
          const parentTweet = await this.twitterClient.getTweet(currentTweet.inReplyToStatusId);
          if (parentTweet) {
            elizaLogger.log("Found parent tweet:", {
              id: parentTweet.id,
              text: parentTweet.text?.slice(0, 50),
            });
            await processThread(parentTweet, depth + 1);
          } else {
            elizaLogger.log("No parent tweet found for:", currentTweet.inReplyToStatusId);
          }
        } catch (error) {
          elizaLogger.log("Error fetching parent tweet:", {
            tweetId: currentTweet.inReplyToStatusId,
            error,
          });
        }
      } else {
        elizaLogger.log("Reached end of reply chain at:", currentTweet.id);
      }
    }
    await processThread.bind(this)(tweet, 0);
    return thread;
  }
}
