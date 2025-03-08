import {
  ActionTimelineType,
  elizaLogger,
  getEmbeddingZeroVector,
  stringToUuid,
} from "@elizaos/core";
import { Scraper, SearchMode } from "agent-twitter-client";
import { EventEmitter } from "events";
export class RequestQueue {
  queue = [];
  processing = false;
  async add(request) {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      try {
        await request();
      } catch (error) {
        console.error("Error processing request:", error);
        this.queue.unshift(request);
        await this.exponentialBackoff(this.queue.length);
      }
      await this.randomDelay();
    }
    this.processing = false;
  }
  async exponentialBackoff(retryCount) {
    const delay = Math.pow(2, retryCount) * 1e3;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  async randomDelay() {
    const delay = Math.floor(Math.random() * 2e3) + 1500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
export class ClientBase extends EventEmitter {
  static _twitterClients = {};
  twitterClient;
  runtime;
  twitterConfig;
  directions;
  lastCheckedTweetId = null;
  imageDescriptionService;
  temperature = 0.5;
  requestQueue = new RequestQueue();
  profile;
  async cacheTweet(tweet) {
    if (!tweet) {
      console.warn("Tweet is undefined, skipping cache");
      return;
    }
    this.runtime.cacheManager.set(`twitter/tweets/${tweet.id}`, tweet);
  }
  async getCachedTweet(tweetId) {
    const cached = await this.runtime.cacheManager.get(`twitter/tweets/${tweetId}`);
    return cached;
  }
  async getTweet(tweetId) {
    const cachedTweet = await this.getCachedTweet(tweetId);
    if (cachedTweet) {
      return cachedTweet;
    }
    const tweet = await this.requestQueue.add(() => this.twitterClient.getTweet(tweetId));
    await this.cacheTweet(tweet);
    return tweet;
  }
  callback = null;
  onReady() {
    throw new Error("Not implemented in base class, please call from subclass");
  }
  /**
   * Parse the raw tweet data into a standardized Tweet object.
   */
  parseTweet(raw, depth = 0, maxDepth = 3) {
    const canRecurse = depth < maxDepth;
    const quotedStatus =
      raw.quoted_status_result?.result && canRecurse
        ? this.parseTweet(raw.quoted_status_result.result, depth + 1, maxDepth)
        : void 0;
    const retweetedStatus =
      raw.retweeted_status_result?.result && canRecurse
        ? this.parseTweet(raw.retweeted_status_result.result, depth + 1, maxDepth)
        : void 0;
    const t = {
      bookmarkCount: raw.bookmarkCount ?? raw.legacy?.bookmark_count ?? void 0,
      conversationId: raw.conversationId ?? raw.legacy?.conversation_id_str,
      hashtags: raw.hashtags ?? raw.legacy?.entities?.hashtags ?? [],
      html: raw.html,
      id: raw.id ?? raw.rest_id ?? raw.id_str ?? void 0,
      inReplyToStatus: raw.inReplyToStatus,
      inReplyToStatusId: raw.inReplyToStatusId ?? raw.legacy?.in_reply_to_status_id_str ?? void 0,
      isQuoted: raw.legacy?.is_quote_status === true,
      isPin: raw.isPin,
      isReply: raw.isReply,
      isRetweet: raw.legacy?.retweeted === true,
      isSelfThread: raw.isSelfThread,
      language: raw.legacy?.lang,
      likes: raw.legacy?.favorite_count ?? 0,
      name:
        raw.name ??
        raw?.user_results?.result?.legacy?.name ??
        raw.core?.user_results?.result?.legacy?.name,
      mentions: raw.mentions ?? raw.legacy?.entities?.user_mentions ?? [],
      permanentUrl:
        raw.permanentUrl ??
        (raw.core?.user_results?.result?.legacy?.screen_name && raw.rest_id
          ? `https://x.com/${raw.core?.user_results?.result?.legacy?.screen_name}/status/${raw.rest_id}`
          : void 0),
      photos:
        raw.photos ??
        (raw.legacy?.entities?.media
          ?.filter((media) => media.type === "photo")
          .map((media) => ({
            id: media.id_str,
            url: media.media_url_https,
            alt_text: media.alt_text,
          })) ||
          []),
      place: raw.place,
      poll: raw.poll ?? null,
      quotedStatus,
      quotedStatusId: raw.quotedStatusId ?? raw.legacy?.quoted_status_id_str ?? void 0,
      quotes: raw.legacy?.quote_count ?? 0,
      replies: raw.legacy?.reply_count ?? 0,
      retweets: raw.legacy?.retweet_count ?? 0,
      retweetedStatus,
      retweetedStatusId: raw.legacy?.retweeted_status_id_str ?? void 0,
      text: raw.text ?? raw.legacy?.full_text ?? void 0,
      thread: raw.thread || [],
      timeParsed: raw.timeParsed
        ? new Date(raw.timeParsed)
        : raw.legacy?.created_at
        ? new Date(raw.legacy?.created_at)
        : void 0,
      timestamp:
        raw.timestamp ??
        (raw.legacy?.created_at ? new Date(raw.legacy.created_at).getTime() / 1e3 : void 0),
      urls: raw.urls ?? raw.legacy?.entities?.urls ?? [],
      userId: raw.userId ?? raw.legacy?.user_id_str ?? void 0,
      username: raw.username ?? raw.core?.user_results?.result?.legacy?.screen_name ?? void 0,
      videos:
        raw.videos ?? raw.legacy?.entities?.media?.filter((media) => media.type === "video") ?? [],
      views: raw.views?.count ? Number(raw.views.count) : 0,
      sensitiveContent: raw.sensitiveContent,
    };
    return t;
  }
  constructor(runtime, twitterConfig) {
    super();
    this.runtime = runtime;
    this.twitterConfig = twitterConfig;
    const username = twitterConfig.TWITTER_USERNAME;
    if (ClientBase._twitterClients[username]) {
      this.twitterClient = ClientBase._twitterClients[username];
    } else {
      this.twitterClient = new Scraper();
      ClientBase._twitterClients[username] = this.twitterClient;
    }
    this.directions =
      "- " +
      this.runtime.character.style.all.join("\n- ") +
      "- " +
      this.runtime.character.style.post.join();
  }
  async init() {
    const username = this.twitterConfig.TWITTER_USERNAME;
    const password = this.twitterConfig.TWITTER_PASSWORD;
    const email = this.twitterConfig.TWITTER_EMAIL;
    let retries = this.twitterConfig.TWITTER_RETRY_LIMIT;
    const twitter2faSecret = this.twitterConfig.TWITTER_2FA_SECRET;
    if (!username) {
      throw new Error("Twitter username not configured");
    }
    const cachedCookies = await this.getCachedCookies(username);
    if (cachedCookies) {
      elizaLogger.info("Using cached cookies");
      await this.setCookiesFromArray(cachedCookies);
    }
    elizaLogger.log("Waiting for Twitter login");
    while (retries > 0) {
      try {
        if (await this.twitterClient.isLoggedIn()) {
          elizaLogger.info("Successfully logged in.");
          break;
        } else {
          await this.twitterClient.login(username, password, email, twitter2faSecret);
          if (await this.twitterClient.isLoggedIn()) {
            elizaLogger.info("Successfully logged in.");
            elizaLogger.info("Caching cookies");
            await this.cacheCookies(username, await this.twitterClient.getCookies());
            break;
          }
        }
      } catch (error) {
        elizaLogger.error(`Login attempt failed: ${error.message}`);
      }
      retries--;
      elizaLogger.error(`Failed to login to Twitter. Retrying... (${retries} attempts left)`);
      if (retries === 0) {
        elizaLogger.error("Max retries reached. Exiting login process.");
        throw new Error("Twitter login failed after maximum retries.");
      }
      await new Promise((resolve) => setTimeout(resolve, 2e3));
    }
    this.profile = await this.fetchProfile(username);
    if (this.profile) {
      elizaLogger.log("Twitter user ID:", this.profile.id);
      elizaLogger.log("Twitter loaded:", JSON.stringify(this.profile, null, 10));
      this.runtime.character.twitterProfile = {
        id: this.profile.id,
        username: this.profile.username,
        screenName: this.profile.screenName,
        bio: this.profile.bio,
        nicknames: this.profile.nicknames,
      };
    } else {
      throw new Error("Failed to load profile");
    }
    await this.loadLatestCheckedTweetId();
    await this.populateTimeline();
  }
  async fetchOwnPosts(count) {
    elizaLogger.debug("fetching own posts");
    const homeTimeline = await this.twitterClient.getUserTweets(this.profile.id, count);
    return homeTimeline.tweets.map((t) => this.parseTweet(t));
  }
  /**
   * Fetch timeline for twitter account, optionally only from followed accounts
   */
  async fetchHomeTimeline(count: number, following?: number) {
    elizaLogger.debug("fetching home timeline");
    const homeTimeline = following
      ? await this.twitterClient.fetchFollowingTimeline(count, [])
      : await this.twitterClient.fetchHomeTimeline(count, []);
    elizaLogger.debug(homeTimeline, { depth: Number.POSITIVE_INFINITY });
    const processedTimeline = homeTimeline
      .filter((t) => t.__typename !== "TweetWithVisibilityResults")
      .map((tweet) => this.parseTweet(tweet));
    return processedTimeline;
  }
  async fetchTimelineForActions(count) {
    elizaLogger.debug("fetching timeline for actions");
    const agentUsername = this.twitterConfig.TWITTER_USERNAME;
    const homeTimeline =
      this.twitterConfig.ACTION_TIMELINE_TYPE === ActionTimelineType.Following
        ? await this.twitterClient.fetchFollowingTimeline(count, [])
        : await this.twitterClient.fetchHomeTimeline(count, []);
    return homeTimeline
      .map((tweet) => this.parseTweet(tweet))
      .filter((tweet) => tweet.username !== agentUsername)
      .slice(0, count);
  }
  async fetchSearchTweets(query, maxTweets, searchMode, cursor?): Promise<{ tweets: [] }> {
    try {
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve({ tweets: [] }), 15e3)
      );
      try {
        const result = await this.requestQueue.add(
          async () =>
            await Promise.race([
              this.twitterClient.fetchSearchTweets(query, maxTweets, searchMode, cursor),
              timeoutPromise,
            ])
        );
        return (result ?? { tweets: [] }) as { tweets: [] };
      } catch (error) {
        elizaLogger.error("Error fetching search tweets:", error);
        return { tweets: [] };
      }
    } catch (error) {
      elizaLogger.error("Error fetching search tweets:", error);
      return { tweets: [] };
    }
  }
  async populateTimeline() {
    elizaLogger.debug("populating timeline...");
    const cachedTimeline = await this.getCachedTimeline();
    if (cachedTimeline) {
      const existingMemories2 = await this.runtime.messageManager.getMemoriesByRoomIds({
        roomIds: cachedTimeline.map((tweet) =>
          stringToUuid(tweet.conversationId + "-" + this.runtime.agentId)
        ),
      });
      const existingMemoryIds2 = new Set(existingMemories2.map((memory) => memory.id.toString()));
      const someCachedTweetsExist = cachedTimeline.some((tweet) =>
        existingMemoryIds2.has(stringToUuid(tweet.id + "-" + this.runtime.agentId))
      );
      if (someCachedTweetsExist) {
        const tweetsToSave2 = cachedTimeline.filter(
          (tweet) => !existingMemoryIds2.has(stringToUuid(tweet.id + "-" + this.runtime.agentId))
        );
        console.log({
          processingTweets: tweetsToSave2.map((tweet) => tweet.id).join(","),
        });
        for (const tweet of tweetsToSave2) {
          elizaLogger.log("Saving Tweet", tweet.id);
          const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);
          const userId =
            tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid(tweet.userId);
          if (tweet.userId === this.profile.id) {
            await this.runtime.ensureConnection(
              this.runtime.agentId,
              roomId,
              this.profile.username,
              this.profile.screenName,
              "twitter"
            );
          } else {
            await this.runtime.ensureConnection(
              userId,
              roomId,
              tweet.username,
              tweet.name,
              "twitter"
            );
          }
          const content = {
            text: tweet.text,
            url: tweet.permanentUrl,
            source: "twitter",
            inReplyTo: tweet.inReplyToStatusId
              ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
              : void 0,
          };
          elizaLogger.log("Creating memory for tweet", tweet.id);
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger.log("Memory already exists, skipping timeline population");
            break;
          }
          await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId,
            content,
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp * 1e3,
          });
          await this.cacheTweet(tweet);
        }
        elizaLogger.log(`Populated ${tweetsToSave2.length} missing tweets from the cache.`);
        return;
      }
    }
    const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);
    const username = this.twitterConfig.TWITTER_USERNAME;
    const mentionsAndInteractions = await this.fetchSearchTweets(
      `@${username}`,
      20,
      SearchMode.Latest
    );
    const allTweets = [...timeline, ...mentionsAndInteractions.tweets];
    const tweetIdsToCheck = /* @__PURE__ */ new Set();
    const roomIds = /* @__PURE__ */ new Set();
    for (const tweet of allTweets) {
      tweetIdsToCheck.add(tweet.id);
      roomIds.add(stringToUuid(tweet.conversationId + "-" + this.runtime.agentId));
    }
    const existingMemories = await this.runtime.messageManager.getMemoriesByRoomIds({
      roomIds: Array.from(roomIds),
    });
    const existingMemoryIds = new Set(existingMemories.map((memory) => memory.id));
    const tweetsToSave = allTweets.filter(
      (tweet) => !existingMemoryIds.has(stringToUuid(tweet.id + "-" + this.runtime.agentId))
    );
    elizaLogger.debug({
      processingTweets: tweetsToSave.map((tweet) => tweet.id).join(","),
    });
    await this.runtime.ensureUserExists(
      this.runtime.agentId,
      this.profile.username,
      this.runtime.character.name,
      "twitter"
    );
    for (const tweet of tweetsToSave) {
      elizaLogger.log("Saving Tweet", tweet.id);
      const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);
      const userId =
        tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid(tweet.userId);
      if (tweet.userId === this.profile.id) {
        await this.runtime.ensureConnection(
          this.runtime.agentId,
          roomId,
          this.profile.username,
          this.profile.screenName,
          "twitter"
        );
      } else {
        await this.runtime.ensureConnection(userId, roomId, tweet.username, tweet.name, "twitter");
      }
      const content = {
        text: tweet.text,
        url: tweet.permanentUrl,
        source: "twitter",
        inReplyTo: tweet.inReplyToStatusId ? stringToUuid(tweet.inReplyToStatusId) : void 0,
      };
      await this.runtime.messageManager.createMemory({
        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
        userId,
        content,
        agentId: this.runtime.agentId,
        roomId,
        embedding: getEmbeddingZeroVector(),
        createdAt: tweet.timestamp * 1e3,
      });
      await this.cacheTweet(tweet);
    }
    await this.cacheTimeline(timeline);
    await this.cacheMentions(mentionsAndInteractions.tweets);
  }
  async setCookiesFromArray(cookiesArray) {
    const cookieStrings = cookiesArray.map(
      (cookie) =>
        `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
          cookie.secure ? "Secure" : ""
        }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${cookie.sameSite || "Lax"}`
    );
    await this.twitterClient.setCookies(cookieStrings);
  }
  async saveRequestMessage(message, state) {
    if (message.content.text) {
      const recentMessage = await this.runtime.messageManager.getMemories({
        roomId: message.roomId,
        count: 1,
        unique: false,
      });
      if (recentMessage.length > 0 && recentMessage[0].content === message.content) {
        elizaLogger.debug("Message already saved", recentMessage[0].id);
      } else {
        await this.runtime.messageManager.createMemory({
          ...message,
          embedding: getEmbeddingZeroVector(),
        });
      }
      await this.runtime.evaluate(message, {
        ...state,
        twitterClient: this.twitterClient,
      });
    }
  }
  async loadLatestCheckedTweetId() {
    const latestCheckedTweetId = await this.runtime.cacheManager.get(
      `twitter/${this.profile.username}/latest_checked_tweet_id`
    );
    if (latestCheckedTweetId) {
      this.lastCheckedTweetId = BigInt(latestCheckedTweetId);
    }
  }
  async cacheLatestCheckedTweetId() {
    if (this.lastCheckedTweetId) {
      await this.runtime.cacheManager.set(
        `twitter/${this.profile.username}/latest_checked_tweet_id`,
        this.lastCheckedTweetId.toString()
      );
    }
  }
  async getCachedTimeline() {
    return await this.runtime.cacheManager.get(`twitter/${this.profile.username}/timeline`);
  }
  async cacheTimeline(timeline) {
    await this.runtime.cacheManager.set(`twitter/${this.profile.username}/timeline`, timeline, {
      expires: Date.now() + 10 * 1e3,
    });
  }
  async cacheMentions(mentions) {
    await this.runtime.cacheManager.set(`twitter/${this.profile.username}/mentions`, mentions, {
      expires: Date.now() + 10 * 1e3,
    });
  }
  async getCachedCookies(username) {
    return await this.runtime.cacheManager.get(`twitter/${username}/cookies`);
  }
  async cacheCookies(username, cookies) {
    await this.runtime.cacheManager.set(`twitter/${username}/cookies`, cookies);
  }
  async fetchProfile(username) {
    try {
      const profile = await this.requestQueue.add(async () => {
        const profile2 = await this.twitterClient.getProfile(username);
        return {
          id: profile2.userId,
          username,
          screenName: profile2.name || this.runtime.character.name,
          bio:
            profile2.biography || typeof this.runtime.character.bio === "string"
              ? this.runtime.character.bio
              : this.runtime.character.bio.length > 0
              ? this.runtime.character.bio[0]
              : "",
          nicknames: this.runtime.character.twitterProfile?.nicknames || [],
        };
      });
      return profile;
    } catch (error) {
      console.error("Error fetching Twitter profile:", error);
      throw error;
    }
  }
}
