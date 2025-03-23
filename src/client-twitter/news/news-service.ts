import { elizaLogger } from "@elizaos/core";
import BigNumber from "bignumber.js";
import * as fs from "fs";
import * as path from "path";
import { News } from "../canister/ic.news.ts";
import { createNewsActor } from "./actor.ts";
import { convertMetadata } from "./types.ts";

/**
 * Report types that can be fetched from the API
 */
export enum ReportType {
  ICTRANSACTION = "IC Transaction",
  AGGREGATED = "Aggregated",
}

/**
 * Interface representing a news report
 */
export interface NewsReport {
  id: string;
  type: ReportType;
  content: string;
  timestamp: number;
}

/**
 * Service for interacting with the news canister and database
 */
export class NewsService {
  private static readonly STORAGE_FILE = "news_last_sent.json";
  private static readonly DATA_DIR = process.env.DATA_DIR || "./data";
  private storagePath: string;
  private cache: Record<string, number> = {};
  constructor(private canisterId: string) {
    this.storagePath = path.join(NewsService.DATA_DIR, NewsService.STORAGE_FILE);
    this.loadFromFile();
  }

  /**
   * Fetches new reports that haven't been sent yet
   */
  async fetchNewReports(): Promise<NewsReport[]> {
    try {
      // Get the last sent timestamp for each report type
      const lastSentTimestamps = await this.getLastSentTimestamps();

      // Create actor to interact with the canister
      const actor = await createNewsActor(this.canisterId);

      if (!actor) {
        const error = new Error("Failed to create news actor");
        console.error(error);
        throw error;
      }

      // Fetch latest news from the canister (e.g., 20 latest items)
      elizaLogger.info(
        "NewsService",
        `Fetching latest news from canister ${this.canisterId}, limit: 30`
      );
      const response = await actor.query_latest_news(BigInt(30));

      if ("err" in response) {
        const error = new Error(`Error from canister: ${JSON.stringify(response.err)}`);
        console.error(error);
        throw error;
      }

      elizaLogger.info("NewsService", `Received ${response.ok.length} news items from canister`);

      // Convert canister news to our format
      const reports: NewsReport[] = response.ok
        .filter((news: News) => {
          // Only get news with specific tags
          return (
            // news.tags.includes(ReportType.ICTRANSACTION) ||
            news.tags.includes(ReportType.AGGREGATED)
          );
        })
        .map((news: News) => {
          const createdAt = new BigNumber(Number(news.created_at)).toNumber();
          const metadata = convertMetadata(news.metadata);
          const content = metadata.source;
          // Determine report type based on content or metadata
          const reportType = this.determineReportType(news);
          // let url = `https://icnews.io/news/${news.hash}`;
          return {
            id: news.hash,
            type: reportType,
            content: `${news.title}\n\n${content}`,
            timestamp: createdAt,
          };
        })
        .filter((report) => {
          const lastSent = lastSentTimestamps[report.type] || 0;
          // Filter out reports that have already been sent
          const isNew = report.timestamp > lastSent;
          if (!isNew) {
            elizaLogger.info(
              "NewsService",
              `Skipping already sent report: ${report.id} (${report.type}), timestamp: ${report.timestamp}, last sent: ${lastSent}`
            );
          }
          return isNew;
        });

      elizaLogger.info("NewsService", `Found ${reports.length} new reports to process`);

      // Log detailed information about each report
      reports.forEach((report, index) => {
        elizaLogger.info(
          "NewsService",
          `Report ${index + 1}/${reports.length}: 
          ID: ${report.id}
          Type: ${report.type}
          Timestamp: ${report.timestamp}
          Content Preview: ${report.content.substring(0, 100)}...`
        );
      });

      console.log(`Found ${reports.length} new reports to process`);
      return reports;
    } catch (error) {
      console.error("Error fetching news reports:", error);
      // Rethrow error if it's critical and should be handled by caller
      // Otherwise return empty array to allow graceful degradation
      return [];
    }
  }

  /**
   * Determines the report type based on news content and metadata
   * @param news The news item from the canister
   * @returns The appropriate report type
   */
  private determineReportType(news: any): ReportType {
    // Check title and description for keywords that might indicate report type
    if (news.tags.includes(ReportType.ICTRANSACTION)) {
      return ReportType.ICTRANSACTION;
    }
    if (news.tags.includes(ReportType.AGGREGATED)) {
      return ReportType.AGGREGATED;
    }
  }

  /**
   * Gets the last sent timestamp for each report type
   */
  private async getLastSentTimestamps(): Promise<Record<string, number>> {
    const timestamps: Record<string, number> = {};

    for (const type of Object.values(ReportType)) {
      const lastSent = await this.getLastSentTimestamp(type);
      timestamps[type] = lastSent || 0;
    }

    return timestamps;
  }

  /**
   * Marks a report as sent by updating its last sent timestamp
   */
  async markReportAsSent(reportId: string): Promise<void> {
    const report = await this.getReportById(reportId);
    if (report) {
      await this.updateLastSentTimestamp(report.type, Date.now());
    }
  }

  /**
   * Gets a report by its ID (hash)
   */
  private async getReportById(reportId: string): Promise<NewsReport | null> {
    try {
      const actor = await createNewsActor(this.canisterId);

      if (!actor) {
        const error = new Error("Failed to create news actor");
        console.error(error);
        return null;
      }

      const response = await actor.get_news_by_hash(reportId);

      if ("err" in response) {
        const error = new Error(
          `Error from canister when getting report by ID ${reportId}: ${JSON.stringify(
            response.err
          )}`
        );
        console.error(error);
        return null;
      }

      const news = response.ok;
      const createdAt = new BigNumber(Number(news.created_at)).toNumber();
      const metadata = convertMetadata(news.metadata);

      return {
        id: news.hash,
        type: this.determineReportType(news),
        content: `${news.title}\n\n${metadata.source}\n\n`,
        timestamp: createdAt,
      };
    } catch (error) {
      console.error(`Error getting report by ID ${reportId}:`, error);
      return null;
    }
  }

  /**
   * Loads timestamp data from file
   */
  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = fs.readFileSync(this.storagePath, "utf8");
        this.cache = JSON.parse(data);
        elizaLogger.info("News storage", "Loaded timestamp data from file");
      } else {
        // Initialize with empty object if file doesn't exist
        this.cache = {};
        this.saveToFile(); // Create the file
        elizaLogger.info("News storage", "Created new timestamp storage file");
      }
    } catch (error) {
      elizaLogger.error("News storage", "Error loading timestamp data:", error);
      this.cache = {};
    }
  }

  /**
   * Saves timestamp data to file
   */
  private saveToFile(): void {
    try {
      fs.writeFileSync(this.storagePath, JSON.stringify(this.cache, null, 2), "utf8");
    } catch (error) {
      elizaLogger.error("News storage", "Error saving timestamp data:", error);
    }
  }

  /**
   * Gets the last sent timestamp for a specific report type
   */
  async getLastSentTimestamp(reportType: string): Promise<number | null> {
    try {
      return this.cache[reportType] || null;
    } catch (error) {
      elizaLogger.error(
        `News storage: Error getting last sent timestamp for ${reportType}:`,
        error
      );
      return null;
    }
  }

  /**
   * Updates the last sent timestamp for a specific report type
   */
  async updateLastSentTimestamp(reportType: string, timestamp: number): Promise<void> {
    try {
      this.cache[reportType] = timestamp;
      this.saveToFile();
    } catch (error) {
      elizaLogger.error(
        `News storage: Error updating last sent timestamp for ${reportType}:`,
        error
      );
    }
  }
}
