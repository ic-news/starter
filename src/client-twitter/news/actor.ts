import { Actor, HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import type { _SERVICE } from "../canister/ic.news.ts";
import { idlFactory } from "../canister/ic.news.ts";

/**
 * Creates an actor for interacting with the news canister
 * @param defaultCanisterId Optional default canister ID to use if environment variable is not set
 */
export const createNewsActor = async (defaultCanisterId?: string): Promise<_SERVICE | null> => {
  try {
    // Try to get canister ID from environment variables, checking both standard and React naming conventions
    const canisterId = process.env.REACT_APP_NEWS_CANISTER_ID || defaultCanisterId;

    if (!canisterId) {
      console.error("News canister ID not found in environment variables or default parameter");
      return null;
    }

    // Create an agent to talk to the IC network
    const agent = new HttpAgent({
      host: "https://ic0.app", // IC mainnet
    });

    // When not in production, we need to fetch the root key
    if (process.env.NODE_ENV !== "production") {
      await agent.fetchRootKey();
    }

    // Create an actor using the canister interface
    const actor = Actor.createActor<_SERVICE>(idlFactory, {
      agent,
      canisterId: Principal.fromText(canisterId),
    });

    return actor;
  } catch (error) {
    console.error("Error creating news actor:", error);
    return null;
  }
};
