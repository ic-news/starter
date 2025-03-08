// src/index.ts
import { AgentRuntime, elizaLogger } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { validateTwitterConfig } from "./environment.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { NewsPlugin } from "./news/index.ts";
import { TwitterPostClient } from "./post.ts";
import { TwitterSearchClient } from "./search.ts";
import { TwitterSpaceClient } from "./spaces.ts";

// Export plugins
export { NewsPlugin };

export class TwitterManager {
  client;
  post;
  search;
  interaction;
  space;
  constructor(runtime: AgentRuntime, twitterConfig) {
    this.client = new ClientBase(runtime, twitterConfig);
    this.post = new TwitterPostClient(this.client, runtime);
    if (twitterConfig.TWITTER_SEARCH_ENABLE) {
      elizaLogger.warn("Twitter/X client running in a mode that:");
      elizaLogger.warn("1. violates consent of random users");
      elizaLogger.warn("2. burns your rate limit");
      elizaLogger.warn("3. can get your account banned");
      elizaLogger.warn("use at your own risk");
      this.search = new TwitterSearchClient(this.client, runtime);
    }
    this.interaction = new TwitterInteractionClient(this.client, runtime);
    if (twitterConfig.TWITTER_SPACES_ENABLE) {
      this.space = new TwitterSpaceClient(this.client, runtime);
    }
    new NewsPlugin(this.post, this.client, runtime);
  }
}

export const TwitterClientInterface = {
  async start(runtime) {
    const twitterConfig = await validateTwitterConfig(runtime);
    elizaLogger.log("Twitter client started");
    const manager = new TwitterManager(runtime, twitterConfig);
    await manager.client.init();
    await manager.post.start();
    if (manager.search) {
      await manager.search.start();
    }
    await manager.interaction.start();
    if (manager.space) {
      manager.space.startPeriodicSpaceCheck();
    }
    return manager;
  },
  async stop(_runtime) {
    elizaLogger.warn("Twitter client does not support stopping yet");
  },
};

export default TwitterClientInterface;
