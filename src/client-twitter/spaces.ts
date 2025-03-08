// src/spaces.ts
import { composeContext, elizaLogger, generateText, ModelClass, ServiceType } from "@elizaos/core";
import { IdleMonitorPlugin, RecordToDiskPlugin, Space } from "agent-twitter-client";
import { SttTtsPlugin } from "./plugins/SttTtsSpacesPlugin.ts";

export async function generateFiller(runtime, fillerType) {
  try {
    const context = composeContext({
      state: { fillerType } as any,
      template: `
# INSTRUCTIONS:
You are generating a short filler message for a Twitter Space. The filler type is "{{fillerType}}".
Keep it brief, friendly, and relevant. No more than two sentences.
Only return the text, no additional formatting.

---
`,
    });
    const output = await generateText({
      runtime,
      context,
      modelClass: ModelClass.SMALL,
    });
    return output.trim();
  } catch (err) {
    elizaLogger.error("[generateFiller] Error generating filler:", err);
    return "";
  }
}
export async function speakFiller(runtime, sttTtsPlugin, fillerType, sleepAfterMs = 3e3) {
  if (!sttTtsPlugin) return;
  const text = await generateFiller(runtime, fillerType);
  if (!text) return;
  elizaLogger.log(`[Space] Filler (${fillerType}) => ${text}`);
  await sttTtsPlugin.speakText(text);
  if (sleepAfterMs > 0) {
    await new Promise((res) => setTimeout(res, sleepAfterMs));
  }
}
export async function generateTopicsIfEmpty(runtime) {
  try {
    const context = composeContext({
      state: {} as any,
      template: `
# INSTRUCTIONS:
Please generate 5 short topic ideas for a Twitter Space about technology or random interesting subjects.
Return them as a comma-separated list, no additional formatting or numbering.

Example:
"AI Advances, Futuristic Gadgets, Space Exploration, Quantum Computing, Digital Ethics"
---
`,
    });
    const response = await generateText({
      runtime,
      context,
      modelClass: ModelClass.SMALL,
    });
    const topics = response
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return topics.length ? topics : ["Random Tech Chat", "AI Thoughts"];
  } catch (err) {
    elizaLogger.error("[generateTopicsIfEmpty] GPT error =>", err);
    return ["Random Tech Chat", "AI Thoughts"];
  }
}
export class TwitterSpaceClient {
  runtime;
  client;
  scraper;
  isSpaceRunning = false;
  currentSpace;
  spaceId;
  startedAt;
  checkInterval;
  lastSpaceEndedAt;
  sttTtsPlugin;
  /**
   * We now store an array of active speakers, not just 1
   */
  activeSpeakers = [];
  speakerQueue = [];
  decisionOptions;
  constructor(client, runtime) {
    this.client = client;
    this.scraper = client.twitterClient;
    this.runtime = runtime;
    const charSpaces = runtime.character.twitterSpaces || {};
    this.decisionOptions = {
      maxSpeakers: charSpaces.maxSpeakers ?? 1,
      topics: charSpaces.topics ?? [],
      typicalDurationMinutes: charSpaces.typicalDurationMinutes ?? 30,
      idleKickTimeoutMs: charSpaces.idleKickTimeoutMs ?? 5 * 6e4,
      minIntervalBetweenSpacesMinutes: charSpaces.minIntervalBetweenSpacesMinutes ?? 60,
      businessHoursOnly: charSpaces.businessHoursOnly ?? false,
      randomChance: charSpaces.randomChance ?? 0.3,
      enableIdleMonitor: charSpaces.enableIdleMonitor !== false,
      enableSttTts: charSpaces.enableSttTts !== false,
      enableRecording: charSpaces.enableRecording !== false,
      voiceId:
        charSpaces.voiceId || runtime.character.settings.voice.model || "Xb7hH8MSUJpSbSDYk0k2",
      sttLanguage: charSpaces.sttLanguage || "en",
      speakerMaxDurationMs: charSpaces.speakerMaxDurationMs ?? 4 * 6e4,
    };
  }
  /**
   * Periodic check to launch or manage space
   */
  async startPeriodicSpaceCheck() {
    elizaLogger.log("[Space] Starting periodic check routine...");
    const intervalMsWhenIdle = 5 * 6e4;
    const intervalMsWhenRunning = 5e3;
    const routine = async () => {
      try {
        if (!this.isSpaceRunning) {
          const launch = await this.shouldLaunchSpace();
          if (launch) {
            const config = await this.generateSpaceConfig();
            await this.startSpace(config);
          }
          this.checkInterval = setTimeout(
            routine,
            this.isSpaceRunning ? intervalMsWhenRunning : intervalMsWhenIdle
          );
        } else {
          await this.manageCurrentSpace();
          this.checkInterval = setTimeout(routine, intervalMsWhenRunning);
        }
      } catch (error) {
        elizaLogger.error("[Space] Error in routine =>", error);
        this.checkInterval = setTimeout(routine, intervalMsWhenIdle);
      }
    };
    routine();
  }
  stopPeriodicCheck() {
    if (this.checkInterval) {
      clearTimeout(this.checkInterval);
      this.checkInterval = void 0;
    }
  }
  async shouldLaunchSpace() {
    const r = Math.random();
    if (r > (this.decisionOptions.randomChance ?? 0.3)) {
      elizaLogger.log("[Space] Random check => skip launching");
      return false;
    }
    if (this.decisionOptions.businessHoursOnly) {
      const hour = /* @__PURE__ */ new Date().getUTCHours();
      if (hour < 9 || hour >= 17) {
        elizaLogger.log("[Space] Out of business hours => skip");
        return false;
      }
    }
    const now = Date.now();
    if (this.lastSpaceEndedAt) {
      const minIntervalMs = (this.decisionOptions.minIntervalBetweenSpacesMinutes ?? 60) * 6e4;
      if (now - this.lastSpaceEndedAt < minIntervalMs) {
        elizaLogger.log("[Space] Too soon since last space => skip");
        return false;
      }
    }
    elizaLogger.log("[Space] Deciding to launch a new Space...");
    return true;
  }
  async generateSpaceConfig() {
    if (!this.decisionOptions.topics || this.decisionOptions.topics.length === 0) {
      const newTopics = await generateTopicsIfEmpty(this.client.runtime);
      this.decisionOptions.topics = newTopics;
    }
    let chosenTopic = "Random Tech Chat";
    if (this.decisionOptions.topics && this.decisionOptions.topics.length > 0) {
      chosenTopic =
        this.decisionOptions.topics[Math.floor(Math.random() * this.decisionOptions.topics.length)];
    }
    return {
      mode: "INTERACTIVE",
      title: chosenTopic,
      description: `Discussion about ${chosenTopic}`,
      languages: ["en"],
    };
  }
  async startSpace(config) {
    elizaLogger.log("[Space] Starting a new Twitter Space...");
    try {
      this.currentSpace = new Space(this.scraper);
      this.isSpaceRunning = false;
      this.spaceId = void 0;
      this.startedAt = Date.now();
      this.activeSpeakers = [];
      this.speakerQueue = [];
      const elevenLabsKey = this.runtime.getSetting("ELEVENLABS_XI_API_KEY") || "";
      const broadcastInfo = await this.currentSpace.initialize(config);
      this.spaceId = broadcastInfo.room_id;
      if (this.decisionOptions.enableRecording) {
        elizaLogger.log("[Space] Using RecordToDiskPlugin");
        this.currentSpace.use(new RecordToDiskPlugin());
      }
      if (this.decisionOptions.enableSttTts) {
        elizaLogger.log("[Space] Using SttTtsPlugin");
        const sttTts = new SttTtsPlugin();
        this.sttTtsPlugin = sttTts;
        this.currentSpace.use(sttTts, {
          runtime: this.runtime,
          client: this.client,
          spaceId: this.spaceId,
          elevenLabsApiKey: elevenLabsKey,
          voiceId: this.decisionOptions.voiceId,
          sttLanguage: this.decisionOptions.sttLanguage,
          transcriptionService: this.client.runtime.getService(ServiceType.TRANSCRIPTION),
        });
      }
      if (this.decisionOptions.enableIdleMonitor) {
        elizaLogger.log("[Space] Using IdleMonitorPlugin");
        this.currentSpace.use(
          new IdleMonitorPlugin(this.decisionOptions.idleKickTimeoutMs ?? 6e4, 1e4)
        );
      }
      this.isSpaceRunning = true;
      await this.scraper.sendTweet(broadcastInfo.share_url.replace("broadcasts", "spaces"));
      const spaceUrl = broadcastInfo.share_url.replace("broadcasts", "spaces");
      elizaLogger.log(`[Space] Space started => ${spaceUrl}`);
      await speakFiller(this.client.runtime, this.sttTtsPlugin, "WELCOME");
      this.currentSpace.on("occupancyUpdate", (update) => {
        elizaLogger.log(`[Space] Occupancy => ${update.occupancy} participant(s).`);
      });
      this.currentSpace.on("speakerRequest", async (req) => {
        elizaLogger.log(`[Space] Speaker request from @${req.username} (${req.userId}).`);
        await this.handleSpeakerRequest(req);
      });
      this.currentSpace.on("idleTimeout", async (info) => {
        elizaLogger.log(`[Space] idleTimeout => no audio for ${info.idleMs} ms.`);
        await speakFiller(this.client.runtime, this.sttTtsPlugin, "IDLE_ENDING");
        await this.stopSpace();
      });
      process.on("SIGINT", async () => {
        elizaLogger.log("[Space] SIGINT => stopping space");
        await speakFiller(this.client.runtime, this.sttTtsPlugin, "CLOSING");
        await this.stopSpace();
        process.exit(0);
      });
    } catch (error) {
      elizaLogger.error("[Space] Error launching Space =>", error);
      this.isSpaceRunning = false;
      throw error;
    }
  }
  /**
   * Periodic management: check durations, remove extras, maybe accept new from queue
   */
  async manageCurrentSpace() {
    if (!this.spaceId || !this.currentSpace) return;
    try {
      const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
      const { participants } = audioSpace;
      const numSpeakers = participants.speakers?.length || 0;
      const totalListeners = participants.listeners?.length || 0;
      const maxDur = this.decisionOptions.speakerMaxDurationMs ?? 24e4;
      const now = Date.now();
      for (let i = this.activeSpeakers.length - 1; i >= 0; i--) {
        const speaker = this.activeSpeakers[i];
        const elapsed = now - speaker.startTime;
        if (elapsed > maxDur) {
          elizaLogger.log(`[Space] Speaker @${speaker.username} exceeded max duration => removing`);
          await this.removeSpeaker(speaker.userId);
          this.activeSpeakers.splice(i, 1);
          await speakFiller(this.client.runtime, this.sttTtsPlugin, "SPEAKER_LEFT");
        }
      }
      await this.acceptSpeakersFromQueueIfNeeded();
      if (numSpeakers > (this.decisionOptions.maxSpeakers ?? 1)) {
        elizaLogger.log("[Space] More than maxSpeakers => removing extras...");
        await this.kickExtraSpeakers(participants.speakers);
      }
      const elapsedMinutes = (now - (this.startedAt || 0)) / 6e4;
      if (
        elapsedMinutes > (this.decisionOptions.typicalDurationMinutes ?? 30) ||
        (numSpeakers === 0 && totalListeners === 0 && elapsedMinutes > 5)
      ) {
        elizaLogger.log("[Space] Condition met => stopping the Space...");
        await speakFiller(this.client.runtime, this.sttTtsPlugin, "CLOSING", 4e3);
        await this.stopSpace();
      }
    } catch (error) {
      elizaLogger.error("[Space] Error in manageCurrentSpace =>", error);
    }
  }
  /**
   * If we have available slots, accept new speakers from the queue
   */
  async acceptSpeakersFromQueueIfNeeded() {
    const ms = this.decisionOptions.maxSpeakers ?? 1;
    while (this.speakerQueue.length > 0 && this.activeSpeakers.length < ms) {
      const nextReq = this.speakerQueue.shift();
      if (nextReq) {
        await speakFiller(this.client.runtime, this.sttTtsPlugin, "PRE_ACCEPT");
        await this.acceptSpeaker(nextReq);
      }
    }
  }
  async handleSpeakerRequest(req) {
    if (!this.spaceId || !this.currentSpace) return;
    const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
    const janusSpeakers = audioSpace?.participants?.speakers || [];
    if (janusSpeakers.length < (this.decisionOptions.maxSpeakers ?? 1)) {
      elizaLogger.log(`[Space] Accepting speaker @${req.username} now`);
      await speakFiller(this.client.runtime, this.sttTtsPlugin, "PRE_ACCEPT");
      await this.acceptSpeaker(req);
    } else {
      elizaLogger.log(`[Space] Adding speaker @${req.username} to the queue`);
      this.speakerQueue.push(req);
    }
  }
  async acceptSpeaker(req) {
    if (!this.currentSpace) return;
    try {
      await this.currentSpace.approveSpeaker(req.userId, req.sessionUUID);
      this.activeSpeakers.push({
        userId: req.userId,
        sessionUUID: req.sessionUUID,
        username: req.username,
        startTime: Date.now(),
      });
      elizaLogger.log(`[Space] Speaker @${req.username} is now live`);
    } catch (err) {
      elizaLogger.error(`[Space] Error approving speaker @${req.username}:`, err);
    }
  }
  async removeSpeaker(userId) {
    if (!this.currentSpace) return;
    try {
      await this.currentSpace.removeSpeaker(userId);
      elizaLogger.log(`[Space] Removed speaker userId=${userId}`);
    } catch (error) {
      elizaLogger.error(`[Space] Error removing speaker userId=${userId} =>`, error);
    }
  }
  /**
   * If more than maxSpeakers are found, remove extras
   * Also update activeSpeakers array
   */
  async kickExtraSpeakers(speakers) {
    if (!this.currentSpace) return;
    const ms = this.decisionOptions.maxSpeakers ?? 1;
    const extras = speakers.slice(ms);
    for (const sp of extras) {
      elizaLogger.log(`[Space] Removing extra speaker => userId=${sp.user_id}`);
      await this.removeSpeaker(sp.user_id);
      const idx = this.activeSpeakers.findIndex((s) => s.userId === sp.user_id);
      if (idx !== -1) {
        this.activeSpeakers.splice(idx, 1);
      }
    }
  }
  async stopSpace() {
    if (!this.currentSpace || !this.isSpaceRunning) return;
    try {
      elizaLogger.log("[Space] Stopping the current Space...");
      await this.currentSpace.stop();
    } catch (err) {
      elizaLogger.error("[Space] Error stopping Space =>", err);
    } finally {
      this.isSpaceRunning = false;
      this.spaceId = void 0;
      this.currentSpace = void 0;
      this.startedAt = void 0;
      this.lastSpaceEndedAt = Date.now();
      this.activeSpeakers = [];
      this.speakerQueue = [];
    }
  }
}
