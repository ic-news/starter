import { Value } from "../canister/ic.news.ts";

/**
 * News metadata structure
 */
export interface Metadata {
  // Platform identifier (telegram/twitter/x)
  platform: string;
  // Original message URL for content retrieval
  url: string;
  // Channel or account username
  channel: string;
  // Original message identifier from the platform
  messageId: string;
  // Raw source content/text from original message
  source: string;
  // Channel/Account profile picture URL
  profilePic: string;
  // Unique identifier for the content author
  authorId: string;
  // Display name of the content author/channel
  authorName: string;
  // Verification status of the author/channel
  verified: boolean;
  // Sender information
  sender: string;
}

/**
 * Converted news item with processed metadata
 */
export interface News {
  id: string;
  hash: string;
  title: string;
  content: string;
  created_at: number;
  metadata: Metadata;
  category: string;
  tags: string[];
}

/**
 * Response structure for news queries
 */
export interface NewsResponse {
  total: bigint;
  news: Array<News>;
}

/**
 * Helper function to extract text from Value type
 */
export const getValueText = (value: Value | undefined): string => {
  if (!value || !("Text" in value)) {
    return "";
  }
  return value.Text;
};

/**
 * Helper function to extract boolean from Value type
 */
export const getValueBool = (value: Value | undefined): boolean => {
  if (!value || !("Bool" in value)) {
    return false;
  }
  return value.Bool;
};

/**
 * Converts a Value map to Metadata object
 */
export const convertMetadata = (value: Value): Metadata => {
  if ("Map" in value) {
    const metadataMap = new Map(value.Map);
    return {
      platform: getValueText(metadataMap.get("platform")),
      url: getValueText(metadataMap.get("url")),
      channel: getValueText(metadataMap.get("channel")),
      messageId: getValueText(metadataMap.get("messageId")),
      source: getValueText(metadataMap.get("source")),
      profilePic: getValueText(metadataMap.get("profilePic")),
      authorId: getValueText(metadataMap.get("authorId")),
      authorName: getValueText(metadataMap.get("authorName")),
      verified: getValueBool(metadataMap.get("verified")),
      sender:
        getValueText(metadataMap.get("sender")) ||
        getValueText(metadataMap.get("authorName")) ||
        "",
    };
  }
  throw new Error("Invalid metadata format");
};
