import { AgentRuntime, Client, IAgentRuntime, Plugin, elizaLogger } from "@elizaos/core";
import { NewsService } from "./news-service.ts";

/**
 * News plugin for sending periodic reports to Twitter
 * Fetches reports from Internet Computer canister and posts to Twitter
 */
export class NewsPlugin implements Plugin {
  public name = "news-plugin";

  public description = "News plugin for sending periodic reports to Twitter";

  private client: Client;
  private runtime: AgentRuntime;
  private canisterId: string;
  private newsService: NewsService | undefined;
  private post: any | undefined;
  private interval: NodeJS.Timeout | undefined;
  private intervalMs = 1 * 60 * 1000; // Check every 1 minutes

  constructor(post: IAgentRuntime, client: Client, runtime: AgentRuntime) {
    this.client = client;
    this.runtime = runtime;
    // Get the canister ID from environment variables
    this.canisterId = process.env.REACT_APP_NEWS_CANISTER_ID || "";

    if (!this.canisterId) {
      elizaLogger.warn("News plugin", "Canister ID not found in environment variables");
    } else {
      elizaLogger.log("News plugin", `Init News Success, Canister ID: ${this.canisterId} `);
    }

    // Create news service with canister ID
    this.newsService = new NewsService(this.canisterId);

    // Get Twitter client
    this.post = post;
    if (!this.post) {
      elizaLogger.error("News plugin", "Twitter client not found");
      return;
    }

    // Start periodic checking
    this.startPeriodicChecking();

    elizaLogger.success("News plugin", "Successfully started with canister ID:", this.canisterId);
  }

  private startPeriodicChecking(): void {
    this.interval = setInterval(async () => {
      try {
        await this.checkAndPostReports();
      } catch (error) {
        elizaLogger.error("News plugin", "Error checking reports:", error);
      }
    }, this.intervalMs);
  }

  private async checkAndPostReports(): Promise<void> {
    if (!this.newsService || !this.post) return;

    elizaLogger.info("News plugin", "Starting to check for new reports...");

    const reports = await this.newsService.fetchNewReports();

    if (reports.length === 0) {
      elizaLogger.info("News plugin", "No new reports to post");
      return;
    }

    elizaLogger.info("News plugin", `Found ${reports.length} new reports to post`);

    // Post each report to Twitter
    for (const report of reports) {
      try {
        elizaLogger.info("News plugin", `Posting report: ${report.type} - ${report.id}`);
        elizaLogger.info("News plugin", `Report content: ${report.content}`);

        // Check if we're in dry run mode
        const isDryRun =
          process.env.TWITTER_DRY_RUN === "true" || (this.post.post && this.post.post.isDryRun);

        if (isDryRun) {
          elizaLogger.info("News plugin", `[DRY RUN] Would post: ${report.content}`);
        } else {
          // Use sendTweet function to post the news
          elizaLogger.info("News plugin", "Posting news using sendTweet function...");

          // Create content object for sendTweet
          const tweetContent = {
            text: report.content,
            attachments: [], // No attachments for news tweets
          };

          // Generate a room ID for tracking purposes
          const roomId = `news-${report.id}`;

          // Get Twitter username from client config
          const twitterUsername =
            this.post.twitterUsername || (this.post.post && this.post.post.twitterUsername);

          // Send the tweet
          const success = await this.post.postTweet(
            this.runtime,
            this.client,
            report.content, // Use report.content as tweetTextForPosting
            roomId,
            tweetContent,
            twitterUsername
          );
          await this.newsService.markReportAsSent(report.id);
          if (success) {
            elizaLogger.success("News plugin", `Posted report: ${report.type}`);
          } else {
            elizaLogger.error("News plugin", `Failed to post news: ${report.type}`);
            // Don't mark as sent if posting failed
          }
        }

        // Wait briefly between posts to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        elizaLogger.error("News plugin", `Failed to post report: ${report.type}`, error);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
    }

    if (this.post) {
      elizaLogger.info("News plugin", "Stopped");
    }
  }
}
