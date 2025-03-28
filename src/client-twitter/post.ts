import {
  cleanJsonResponse,
  composeContext,
  elizaLogger,
  extractAttributes,
  generateText,
  generateTweetActions,
  getEmbeddingZeroVector,
  ModelClass,
  parseJSONObjectFromText,
  postActionResponseFooter,
  ServiceType,
  stringToUuid,
  truncateToCompleteSentence,
} from "@elizaos/core";
import { Client, Events, GatewayIntentBits, Partials, TextChannel } from "discord.js";
import { DEFAULT_MAX_TWEET_LENGTH } from "./environment.ts";
import { twitterMessageHandlerTemplate } from "./interactions.ts";
import { buildConversationThread, fetchMediaData } from "./utils.ts";
var MAX_TIMELINES_TO_FETCH = 15;
export const twitterPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than {{maxTweetLength}}. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.`;
export const twitterActionTemplate =
  `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{twitterUserName}}) based on:
{{bio}}
{{postDirections}}

Guidelines:
- ONLY engage with content that DIRECTLY relates to character's core interests
- Direct mentions are priority IF they are on-topic
- Skip ALL content that is:
  - Off-topic or tangentially related
  - From high-profile accounts unless explicitly relevant
  - Generic/viral content without specific relevance
  - Political/controversial unless central to character
  - Promotional/marketing unless directly relevant

Actions (respond only with tags):
[LIKE] - Perfect topic match AND aligns with character (9.8/10)
[RETWEET] - Exceptional content that embodies character's expertise (9.5/10)
[QUOTE] - Can add substantial domain expertise (9.5/10)
[REPLY] - Can contribute meaningful, expert-level insight (9.5/10)

Tweet:
{{currentTweet}}

# Respond with qualifying action tags only. Default to NO action unless extremely confident of relevance.` +
  postActionResponseFooter;
export class TwitterPostClient {
  client;
  runtime;
  twitterUsername;
  isProcessing = false;
  lastProcessTime = 0;
  stopProcessingActions = false;
  isDryRun;
  discordClientForApproval;
  approvalRequired = false;
  discordApprovalChannelId;
  approvalCheckInterval;
  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
    this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
    elizaLogger.log("Twitter Client Configuration:");
    elizaLogger.log(`- Username: ${this.twitterUsername}`);
    elizaLogger.log(`- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`);
    elizaLogger.log(
      `- Post Interval: ${this.client.twitterConfig.POST_INTERVAL_MIN}-${this.client.twitterConfig.POST_INTERVAL_MAX} minutes`
    );
    elizaLogger.log(
      `- Action Processing: ${
        this.client.twitterConfig.ENABLE_ACTION_PROCESSING ? "enabled" : "disabled"
      }`
    );
    elizaLogger.log(`- Action Interval: ${this.client.twitterConfig.ACTION_INTERVAL} minutes`);
    elizaLogger.log(
      `- Post Immediately: ${this.client.twitterConfig.POST_IMMEDIATELY ? "enabled" : "disabled"}`
    );
    elizaLogger.log(
      `- Search Enabled: ${
        this.client.twitterConfig.TWITTER_SEARCH_ENABLE ? "enabled" : "disabled"
      }`
    );
    const targetUsers = this.client.twitterConfig.TWITTER_TARGET_USERS;
    if (targetUsers) {
      elizaLogger.log(`- Target Users: ${targetUsers}`);
    }
    if (this.isDryRun) {
      elizaLogger.log(
        "Twitter client initialized in dry run mode - no actual tweets should be posted"
      );
    }
    const approvalRequired =
      this.runtime.getSetting("TWITTER_APPROVAL_ENABLED")?.toLocaleLowerCase() === "true";
    if (approvalRequired) {
      const discordToken = this.runtime.getSetting("TWITTER_APPROVAL_DISCORD_BOT_TOKEN");
      const approvalChannelId = this.runtime.getSetting("TWITTER_APPROVAL_DISCORD_CHANNEL_ID");
      const APPROVAL_CHECK_INTERVAL =
        Number.parseInt(this.runtime.getSetting("TWITTER_APPROVAL_CHECK_INTERVAL")) || 5 * 60 * 1e3;
      this.approvalCheckInterval = APPROVAL_CHECK_INTERVAL;
      if (!discordToken || !approvalChannelId) {
        throw new Error(
          "TWITTER_APPROVAL_DISCORD_BOT_TOKEN and TWITTER_APPROVAL_DISCORD_CHANNEL_ID are required for approval workflow"
        );
      }
      this.approvalRequired = true;
      this.discordApprovalChannelId = approvalChannelId;
      this.setupDiscordClient();
    }
  }
  setupDiscordClient() {
    this.discordClientForApproval = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
    this.discordClientForApproval.once(Events.ClientReady, (readyClient) => {
      elizaLogger.log(`Discord bot is ready as ${readyClient.user.tag}!`);
      const invite = `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user.id}&permissions=274877991936&scope=bot`;
      elizaLogger.log(
        `Use this link to properly invite the Twitter Post Approval Discord bot: ${invite}`
      );
    });
    this.discordClientForApproval.login(
      this.runtime.getSetting("TWITTER_APPROVAL_DISCORD_BOT_TOKEN")
    );
  }
  async start() {
    if (!this.client.profile) {
      await this.client.init();
    }
    const generateNewTweetLoop = async () => {
      const lastPost = await this.runtime.cacheManager.get(
        "twitter/" + this.twitterUsername + "/lastPost"
      );
      const lastPostTimestamp = lastPost?.timestamp ?? 0;
      const minMinutes = this.client.twitterConfig.POST_INTERVAL_MIN;
      const maxMinutes = this.client.twitterConfig.POST_INTERVAL_MAX;
      const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
      const delay = randomMinutes * 60 * 1e3;
      if (Date.now() > lastPostTimestamp + delay) {
        await this.generateNewTweet();
      }
      setTimeout(() => {
        generateNewTweetLoop();
      }, delay);
      elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
    };
    const processActionsLoop = async () => {
      const actionInterval = this.client.twitterConfig.ACTION_INTERVAL;
      while (!this.stopProcessingActions) {
        try {
          const results = await this.processTweetActions();
          if (results) {
            elizaLogger.log(`Processed ${results.length} tweets`);
            elizaLogger.log(`Next action processing scheduled in ${actionInterval} minutes`);
            await new Promise(
              (resolve) => setTimeout(resolve, actionInterval * 60 * 1e3)
              // now in minutes
            );
          }
        } catch (error) {
          elizaLogger.error("Error in action processing loop:", error);
          await new Promise((resolve) => setTimeout(resolve, 3e4));
        }
      }
    };
    if (this.client.twitterConfig.POST_IMMEDIATELY) {
      await this.generateNewTweet();
    }
    generateNewTweetLoop();
    elizaLogger.log("Tweet generation loop started");
    if (this.client.twitterConfig.ENABLE_ACTION_PROCESSING) {
      processActionsLoop().catch((error) => {
        elizaLogger.error("Fatal error in process actions loop:", error);
      });
    }
    if (this.approvalRequired) this.runPendingTweetCheckLoop();
  }
  runPendingTweetCheckLoop() {
    setInterval(async () => {
      await this.handlePendingTweet();
    }, this.approvalCheckInterval);
  }
  createTweetObject(tweetResult, client, twitterUsername) {
    return {
      id: tweetResult.rest_id,
      name: client.profile.screenName,
      username: client.profile.username,
      text: tweetResult.legacy.full_text,
      conversationId: tweetResult.legacy.conversation_id_str,
      createdAt: tweetResult.legacy.created_at,
      timestamp: new Date(tweetResult.legacy.created_at).getTime(),
      userId: client.profile.id,
      inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
      permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
      hashtags: [],
      mentions: [],
      photos: [],
      thread: [],
      urls: [],
      videos: [],
    };
  }
  async processAndCacheTweet(runtime, client, tweet, roomId, rawTweetContent) {
    await runtime.cacheManager.set(`twitter/${client.profile.username}/lastPost`, {
      id: tweet.id,
      timestamp: Date.now(),
    });
    await client.cacheTweet(tweet);
    elizaLogger.log(`Tweet posted:
 ${tweet.permanentUrl}`);
    await runtime.ensureRoomExists(roomId);
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
    await runtime.messageManager.createMemory({
      id: stringToUuid(tweet.id + "-" + runtime.agentId),
      userId: runtime.agentId,
      agentId: runtime.agentId,
      content: {
        text: rawTweetContent.trim(),
        url: tweet.permanentUrl,
        source: "twitter",
      },
      roomId,
      embedding: getEmbeddingZeroVector(),
      createdAt: tweet.timestamp,
    });
  }
  async handleNoteTweet(client, content, tweetId, mediaData?) {
    try {
      const noteTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendNoteTweet(content, tweetId, mediaData)
      );
      if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
        elizaLogger.warn("handleNoteTweet: Note tweet failed, falling back to standard tweet");
        const truncateContent = truncateToCompleteSentence(
          content,
          this.client.twitterConfig.MAX_TWEET_LENGTH
        );
        return await this.sendStandardTweet(client, truncateContent, tweetId);
      } else {
        return noteTweetResult.data.notetweet_create.tweet_results.result;
      }
    } catch (error) {
      elizaLogger.error("handleNoteTweet: Error sending note tweet:", error);
      return null;
    }
  }
  async sendStandardTweet(client, content, tweetId, mediaData?) {
    try {
      const standardTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendTweet(content, tweetId, mediaData)
      );
      const body = await standardTweetResult.json();
      if (!body?.data?.create_tweet?.tweet_results?.result) {
        elizaLogger.error("sendStandardTweet: Error sending tweet; Bad response:", body);
        return null;
      }
      return body.data.create_tweet.tweet_results.result;
    } catch (error) {
      elizaLogger.error("sendStandardTweet: Error sending tweet:", error);
      return null;
    }
  }
  async postTweet(
    runtime,
    client,
    tweetTextForPosting,
    roomId,
    rawTweetContent,
    twitterUsername,
    mediaData
  ) {
    try {
      elizaLogger.log(`Posting new tweet: ${tweetTextForPosting}`);
      let result;
      if (tweetTextForPosting.length > DEFAULT_MAX_TWEET_LENGTH) {
        result = await this.handleNoteTweet(client, tweetTextForPosting, void 0, mediaData);
      } else {
        result = await this.sendStandardTweet(client, tweetTextForPosting, void 0, mediaData);
      }
      // Only process the tweet if we got a valid result
      if (result) {
        const tweet = this.createTweetObject(result, client, twitterUsername);
        await this.processAndCacheTweet(runtime, client, tweet, roomId, rawTweetContent);
        return true; // Indicate success
      } else {
        return false; // Indicate failure
      }
    } catch (error) {
      elizaLogger.error("postTweet: Error sending tweet:", error);
      return false; // Indicate failure
    }
  }
  /**
   * Generates and posts a new tweet. If isDryRun is true, only logs what would have been posted.
   */
  async generateNewTweet() {
    elizaLogger.log("Generating new tweet");
    try {
      const roomId = stringToUuid("twitter_generate_room-" + this.client.profile.username);
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.client.profile.username,
        this.runtime.character.name,
        "twitter"
      );
      const topics = this.runtime.character.topics.join(", ");
      const maxTweetLength = this.client.twitterConfig.MAX_TWEET_LENGTH;
      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId,
          agentId: this.runtime.agentId,
          content: {
            text: topics || "",
            action: "TWEET",
          },
        },
        {
          twitterUserName: this.client.profile.username,
          maxTweetLength,
        }
      );
      const context = composeContext({
        state,
        template: this.runtime.character.templates?.twitterPostTemplate || twitterPostTemplate,
      });
      elizaLogger.debug("generate post prompt:\n" + context);
      const response = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL,
      });
      const rawTweetContent = cleanJsonResponse(response);
      let tweetTextForPosting = null;
      let mediaData = null;
      const parsedResponse = parseJSONObjectFromText(rawTweetContent);
      if (parsedResponse?.text) {
        tweetTextForPosting = parsedResponse.text;
      }
      if (parsedResponse?.attachments && parsedResponse?.attachments.length > 0) {
        mediaData = await fetchMediaData(parsedResponse.attachments);
      }
      if (!tweetTextForPosting) {
        const parsingText = extractAttributes(rawTweetContent, ["text"]).text;
        if (parsingText) {
          tweetTextForPosting = truncateToCompleteSentence(
            parsingText,
            this.client.twitterConfig.MAX_TWEET_LENGTH
          );
        }
      }
      if (!tweetTextForPosting) {
        tweetTextForPosting = rawTweetContent;
      }
      if (maxTweetLength) {
        tweetTextForPosting = truncateToCompleteSentence(tweetTextForPosting, maxTweetLength);
      }
      const removeQuotes = (str) => str.replace(/^['"](.*)['"]$/, "$1");
      const fixNewLines = (str) => str.replaceAll(/\\n/g, "\n\n");
      tweetTextForPosting = removeQuotes(fixNewLines(tweetTextForPosting));
      if (this.isDryRun) {
        elizaLogger.info(`Dry run: would have posted tweet: ${tweetTextForPosting}`);
        return;
      }
      try {
        if (this.approvalRequired) {
          elizaLogger.log(
            `Sending Tweet For Approval:
 ${tweetTextForPosting}`
          );
          await this.sendForApproval(tweetTextForPosting, roomId, rawTweetContent);
          elizaLogger.log("Tweet sent for approval");
        } else {
          elizaLogger.log(
            `Posting new tweet:
 ${tweetTextForPosting}`
          );
          const success = await this.postTweet(
            this.runtime,
            this.client,
            tweetTextForPosting,
            roomId,
            rawTweetContent,
            this.twitterUsername,
            mediaData
          );
          if (success) {
            elizaLogger.log(`Tweet posted successfully: ${tweetTextForPosting}`);
          } else {
            elizaLogger.error(`Failed to post tweet: ${tweetTextForPosting}`);
          }
        }
      } catch (error) {
        elizaLogger.error("generateNewTweet: Error sending tweet:", error);
      }
    } catch (error) {
      elizaLogger.error("Error generating new tweet:", error);
    }
  }
  async generateTweetContent(tweetState, options) {
    const context = composeContext({
      state: tweetState,
      template:
        options?.template ||
        this.runtime.character.templates?.twitterPostTemplate ||
        twitterPostTemplate,
    });
    const response = await generateText({
      runtime: this.runtime,
      context: options?.context || context,
      modelClass: ModelClass.SMALL,
    });
    elizaLogger.log("generate tweet content response:\n" + response);
    const cleanedResponse = cleanJsonResponse(response);
    const jsonResponse = parseJSONObjectFromText(cleanedResponse);
    if (jsonResponse.text) {
      const truncateContent2 = truncateToCompleteSentence(
        jsonResponse.text,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );
      return truncateContent2;
    }
    if (typeof jsonResponse === "object") {
      const possibleContent = jsonResponse.content || jsonResponse.message || jsonResponse.response;
      if (possibleContent) {
        const truncateContent2 = truncateToCompleteSentence(
          possibleContent,
          this.client.twitterConfig.MAX_TWEET_LENGTH
        );
        return truncateContent2;
      }
    }
    let truncateContent = null;
    const parsingText = extractAttributes(cleanedResponse, ["text"]).text;
    if (parsingText) {
      truncateContent = truncateToCompleteSentence(
        parsingText,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );
    }
    if (!truncateContent) {
      truncateContent = truncateToCompleteSentence(
        cleanedResponse,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );
    }
    return truncateContent;
  }
  /**
   * Processes tweet actions (likes, retweets, quotes, replies). If isDryRun is true,
   * only simulates and logs actions without making API calls.
   */
  async processTweetActions() {
    if (this.isProcessing) {
      elizaLogger.log("Already processing tweet actions, skipping");
      return null;
    }
    try {
      this.isProcessing = true;
      this.lastProcessTime = Date.now();
      elizaLogger.log("Processing tweet actions");
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.twitterUsername,
        this.runtime.character.name,
        "twitter"
      );
      const timelines = await this.client.fetchTimelineForActions(MAX_TIMELINES_TO_FETCH);
      const maxActionsProcessing = this.client.twitterConfig.MAX_ACTIONS_PROCESSING;
      const processedTimelines = [];
      for (const tweet of timelines) {
        try {
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger.log(`Already processed tweet ID: ${tweet.id}`);
            continue;
          }
          const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);
          const tweetState = await this.runtime.composeState(
            {
              userId: this.runtime.agentId,
              roomId,
              agentId: this.runtime.agentId,
              content: { text: "", action: "" },
            },
            {
              twitterUserName: this.twitterUsername,
              currentTweet: `ID: ${tweet.id}
From: ${tweet.name} (@${tweet.username})
Text: ${tweet.text}`,
            }
          );
          const actionContext = composeContext({
            state: tweetState,
            template:
              this.runtime.character.templates?.twitterActionTemplate || twitterActionTemplate,
          });
          const actionResponse = await generateTweetActions({
            runtime: this.runtime,
            context: actionContext,
            modelClass: ModelClass.SMALL,
          });
          if (!actionResponse) {
            elizaLogger.log(`No valid actions generated for tweet ${tweet.id}`);
            continue;
          }
          processedTimelines.push({
            tweet,
            actionResponse,
            tweetState,
            roomId,
          });
        } catch (error) {
          elizaLogger.error(`Error processing tweet ${tweet.id}:`, error);
          continue;
        }
      }
      const sortProcessedTimeline = (arr) => {
        return arr.sort((a, b) => {
          const countTrue = (obj) => Object.values(obj).filter(Boolean).length;
          const countA = countTrue(a.actionResponse);
          const countB = countTrue(b.actionResponse);
          if (countA !== countB) {
            return countB - countA;
          }
          if (a.actionResponse.like !== b.actionResponse.like) {
            return a.actionResponse.like ? -1 : 1;
          }
          return 0;
        });
      };
      const sortedTimelines = sortProcessedTimeline(processedTimelines).slice(
        0,
        maxActionsProcessing
      );
      return this.processTimelineActions(sortedTimelines);
    } catch (error) {
      elizaLogger.error("Error in processTweetActions:", error);
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }
  /**
   * Processes a list of timelines by executing the corresponding tweet actions.
   * Each timeline includes the tweet, action response, tweet state, and room context.
   * Results are returned for tracking completed actions.
   *
   * @param timelines - Array of objects containing tweet details, action responses, and state information.
   * @returns A promise that resolves to an array of results with details of executed actions.
   */
  async processTimelineActions(timelines) {
    const results = [];
    for (const timeline of timelines) {
      const { actionResponse, tweetState, roomId, tweet } = timeline;
      try {
        const executedActions = [];
        if (actionResponse.like) {
          if (this.isDryRun) {
            elizaLogger.info(`Dry run: would have liked tweet ${tweet.id}`);
            executedActions.push("like (dry run)");
          } else {
            try {
              await this.client.twitterClient.likeTweet(tweet.id);
              executedActions.push("like");
              elizaLogger.log(`Liked tweet ${tweet.id}`);
            } catch (error) {
              elizaLogger.error(`Error liking tweet ${tweet.id}:`, error);
            }
          }
        }
        if (actionResponse.retweet) {
          if (this.isDryRun) {
            elizaLogger.info(`Dry run: would have retweeted tweet ${tweet.id}`);
            executedActions.push("retweet (dry run)");
          } else {
            try {
              await this.client.twitterClient.retweet(tweet.id);
              executedActions.push("retweet");
              elizaLogger.log(`Retweeted tweet ${tweet.id}`);
            } catch (error) {
              elizaLogger.error(`Error retweeting tweet ${tweet.id}:`, error);
            }
          }
        }
        if (actionResponse.quote) {
          try {
            const thread = await buildConversationThread(tweet, this.client);
            const formattedConversation = thread
              .map(
                (t) => `@${t.username} (${new Date(t.timestamp * 1e3).toLocaleString()}): ${t.text}`
              )
              .join("\n\n");
            const imageDescriptions = [];
            if (tweet.photos?.length > 0) {
              elizaLogger.log("Processing images in tweet for context");
              for (const photo of tweet.photos) {
                const description = await this.runtime
                  .getService(ServiceType.IMAGE_DESCRIPTION)
                  .describeImage(photo.url);
                imageDescriptions.push(description);
              }
            }
            let quotedContent = "";
            if (tweet.quotedStatusId) {
              try {
                const quotedTweet = await this.client.twitterClient.getTweet(tweet.quotedStatusId);
                if (quotedTweet) {
                  quotedContent = `
Quoted Tweet from @${quotedTweet.username}:
${quotedTweet.text}`;
                }
              } catch (error) {
                elizaLogger.error("Error fetching quoted tweet:", error);
              }
            }
            const enrichedState = await this.runtime.composeState(
              {
                userId: this.runtime.agentId,
                roomId: stringToUuid(tweet.conversationId + "-" + this.runtime.agentId),
                agentId: this.runtime.agentId,
                content: {
                  text: tweet.text,
                  action: "QUOTE",
                },
              },
              {
                twitterUserName: this.twitterUsername,
                currentPost: `From @${tweet.username}: ${tweet.text}`,
                formattedConversation,
                imageContext:
                  imageDescriptions.length > 0
                    ? `
Images in Tweet:
${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
                    : "",
                quotedContent,
              }
            );
            const quoteContent = await this.generateTweetContent(enrichedState, {
              template:
                this.runtime.character.templates?.twitterMessageHandlerTemplate ||
                twitterMessageHandlerTemplate,
            });
            if (!quoteContent) {
              elizaLogger.error("Failed to generate valid quote tweet content");
              return;
            }
            elizaLogger.log("Generated quote tweet content:", quoteContent);
            if (this.isDryRun) {
              elizaLogger.info(
                `Dry run: A quote tweet for tweet ID ${tweet.id} would have been posted with the following content: "${quoteContent}".`
              );
              executedActions.push("quote (dry run)");
            } else {
              const result = await this.client.requestQueue.add(
                async () => await this.client.twitterClient.sendQuoteTweet(quoteContent, tweet.id)
              );
              const body = await result.json();
              if (body?.data?.create_tweet?.tweet_results?.result) {
                elizaLogger.log("Successfully posted quote tweet");
                executedActions.push("quote");
                await this.runtime.cacheManager.set(
                  `twitter/quote_generation_${tweet.id}.txt`,
                  `Context:
${enrichedState}

Generated Quote:
${quoteContent}`
                );
              } else {
                elizaLogger.error("Quote tweet creation failed:", body);
              }
            }
          } catch (error) {
            elizaLogger.error("Error in quote tweet generation:", error);
          }
        }
        if (actionResponse.reply) {
          try {
            await this.handleTextOnlyReply(tweet, tweetState, executedActions);
          } catch (error) {
            elizaLogger.error(`Error replying to tweet ${tweet.id}:`, error);
          }
        }
        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureUserExists(
          stringToUuid(tweet.userId),
          tweet.username,
          tweet.name,
          "twitter"
        );
        await this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId);
        if (!this.isDryRun) {
          await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId: stringToUuid(tweet.userId),
            content: {
              text: tweet.text,
              url: tweet.permanentUrl,
              source: "twitter",
              action: executedActions.join(","),
            },
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp * 1e3,
          });
        }
        results.push({
          tweetId: tweet.id,
          actionResponse,
          executedActions,
        });
      } catch (error) {
        elizaLogger.error(`Error processing tweet ${tweet.id}:`, error);
        continue;
      }
    }
    return results;
  }
  /**
   * Handles text-only replies to tweets. If isDryRun is true, only logs what would
   * have been replied without making API calls.
   */
  async handleTextOnlyReply(tweet, tweetState, executedActions) {
    try {
      const thread = await buildConversationThread(tweet, this.client);
      const formattedConversation = thread
        .map((t) => `@${t.username} (${new Date(t.timestamp * 1e3).toLocaleString()}): ${t.text}`)
        .join("\n\n");
      const imageDescriptions = [];
      if (tweet.photos?.length > 0) {
        elizaLogger.log("Processing images in tweet for context");
        for (const photo of tweet.photos) {
          const description = await this.runtime
            .getService(ServiceType.IMAGE_DESCRIPTION)
            .describeImage(photo.url);
          imageDescriptions.push(description);
        }
      }
      let quotedContent = "";
      if (tweet.quotedStatusId) {
        try {
          const quotedTweet = await this.client.twitterClient.getTweet(tweet.quotedStatusId);
          if (quotedTweet) {
            quotedContent = `
Quoted Tweet from @${quotedTweet.username}:
${quotedTweet.text}`;
          }
        } catch (error) {
          elizaLogger.error("Error fetching quoted tweet:", error);
        }
      }
      const enrichedState = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId: stringToUuid(tweet.conversationId + "-" + this.runtime.agentId),
          agentId: this.runtime.agentId,
          content: { text: tweet.text, action: "" },
        },
        {
          twitterUserName: this.twitterUsername,
          currentPost: `From @${tweet.username}: ${tweet.text}`,
          formattedConversation,
          imageContext:
            imageDescriptions.length > 0
              ? `
Images in Tweet:
${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
              : "",
          quotedContent,
        }
      );
      const replyText = await this.generateTweetContent(enrichedState, {
        template:
          this.runtime.character.templates?.twitterMessageHandlerTemplate ||
          twitterMessageHandlerTemplate,
      });
      if (!replyText) {
        elizaLogger.error("Failed to generate valid reply content");
        return;
      }
      if (this.isDryRun) {
        elizaLogger.info(`Dry run: reply to tweet ${tweet.id} would have been: ${replyText}`);
        executedActions.push("reply (dry run)");
        return;
      }
      elizaLogger.debug("Final reply text to be sent:", replyText);
      let result;
      if (replyText.length > DEFAULT_MAX_TWEET_LENGTH) {
        result = await this.handleNoteTweet(this.client, replyText, tweet.id);
      } else {
        result = await this.sendStandardTweet(this.client, replyText, tweet.id);
      }
      if (result) {
        elizaLogger.log("Successfully posted reply tweet");
        executedActions.push("reply");
        await this.runtime.cacheManager.set(
          `twitter/reply_generation_${tweet.id}.txt`,
          `Context:
${enrichedState}

Generated Reply:
${replyText}`
        );
      } else {
        elizaLogger.error("Tweet reply creation failed");
      }
    } catch (error) {
      elizaLogger.error("Error in handleTextOnlyReply:", error);
    }
  }
  async stop() {
    this.stopProcessingActions = true;
  }
  async sendForApproval(tweetTextForPosting, roomId, rawTweetContent) {
    try {
      const embed = {
        title: "New Tweet Pending Approval",
        description: tweetTextForPosting,
        fields: [
          {
            name: "Character",
            value: this.client.profile.username,
            inline: true,
          },
          {
            name: "Length",
            value: tweetTextForPosting.length.toString(),
            inline: true,
          },
        ],
        footer: {
          text: "Reply with '\u{1F44D}' to post or '\u274C' to discard, This will automatically expire and remove after 24 hours if no response received",
        },
        timestamp: /* @__PURE__ */ new Date().toISOString(),
      };
      const channel = await this.discordClientForApproval.channels.fetch(
        this.discordApprovalChannelId
      );
      if (!channel || !(channel instanceof TextChannel)) {
        throw new Error("Invalid approval channel");
      }
      const message = await channel.send({ embeds: [embed] });
      const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
      const currentPendingTweets = (await this.runtime.cacheManager.get(pendingTweetsKey)) || [];
      currentPendingTweets.push({
        tweetTextForPosting,
        roomId,
        rawTweetContent,
        discordMessageId: message.id,
        channelId: this.discordApprovalChannelId,
        timestamp: Date.now(),
      });
      await this.runtime.cacheManager.set(pendingTweetsKey, currentPendingTweets);
      return message.id;
    } catch (error) {
      elizaLogger.error("Error Sending Twitter Post Approval Request:", error);
      return null;
    }
  }
  async checkApprovalStatus(discordMessageId) {
    try {
      const channel = await this.discordClientForApproval.channels.fetch(
        this.discordApprovalChannelId
      );
      elizaLogger.log(`channel ${JSON.stringify(channel)}`);
      if (!(channel instanceof TextChannel)) {
        elizaLogger.error("Invalid approval channel");
        return "PENDING";
      }
      const message = await channel.messages.fetch(discordMessageId);
      const thumbsUpReaction = message.reactions.cache.find(
        (reaction) => reaction.emoji.name === "\u{1F44D}"
      );
      const rejectReaction = message.reactions.cache.find(
        (reaction) => reaction.emoji.name === "\u274C"
      );
      if (rejectReaction) {
        const count = rejectReaction.count;
        if (count > 0) {
          return "REJECTED";
        }
      }
      if (thumbsUpReaction) {
        const count = thumbsUpReaction.count;
        if (count > 0) {
          return "APPROVED";
        }
      }
      return "PENDING";
    } catch (error) {
      elizaLogger.error("Error checking approval status:", error);
      return "PENDING";
    }
  }
  async cleanupPendingTweet(discordMessageId) {
    const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
    const currentPendingTweets = (await this.runtime.cacheManager.get(pendingTweetsKey)) || [];
    const updatedPendingTweets = currentPendingTweets.filter(
      (tweet) => tweet.discordMessageId !== discordMessageId
    );
    if (updatedPendingTweets.length === 0) {
      await this.runtime.cacheManager.delete(pendingTweetsKey);
    } else {
      await this.runtime.cacheManager.set(pendingTweetsKey, updatedPendingTweets);
    }
  }
  async handlePendingTweet() {
    elizaLogger.log("Checking Pending Tweets...");
    const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
    const pendingTweets = (await this.runtime.cacheManager.get(pendingTweetsKey)) || [];
    for (const pendingTweet of pendingTweets) {
      const isExpired = Date.now() - pendingTweet.timestamp > 24 * 60 * 60 * 1e3;
      if (isExpired) {
        elizaLogger.log("Pending tweet expired, cleaning up");
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(pendingTweet.discordMessageId);
            await originalMessage.reply("This tweet approval request has expired (24h timeout).");
          }
        } catch (error) {
          elizaLogger.error("Error sending expiration notification:", error);
        }
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
        return;
      }
      elizaLogger.log("Checking approval status...");
      const approvalStatus = await this.checkApprovalStatus(pendingTweet.discordMessageId);
      if (approvalStatus === "APPROVED") {
        elizaLogger.log("Tweet Approved, Posting");
        await this.postTweet(
          this.runtime,
          this.client,
          pendingTweet.tweetTextForPosting,
          pendingTweet.roomId,
          pendingTweet.rawTweetContent,
          this.twitterUsername,
          pendingTweet.mediaData
        );
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(pendingTweet.discordMessageId);
            await originalMessage.reply("Tweet has been posted successfully! \u2705");
          }
        } catch (error) {
          elizaLogger.error("Error sending post notification:", error);
        }
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
      } else if (approvalStatus === "REJECTED") {
        elizaLogger.log("Tweet Rejected, Cleaning Up");
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(pendingTweet.discordMessageId);
            await originalMessage.reply("Tweet has been rejected! \u274C");
          }
        } catch (error) {
          elizaLogger.error("Error sending rejection notification:", error);
        }
      }
    }
  }
}
