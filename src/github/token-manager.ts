#!/usr/bin/env bun

import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { GITHUB_API_URL } from "./api/config";
import type { Octokits } from "./api/client";

type RetryOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
};

export class TokenManager {
  private static instance: TokenManager | null = null;
  private token: string | null = null;
  private tokenExpiry: Date | null = null;
  private refreshPromise: Promise<string> | null = null;
  private readonly TOKEN_LIFETIME_MS = 55 * 60 * 1000; // 55 minutes (refresh before 1 hour expiry)

  private constructor() {}

  static getInstance(): TokenManager {
    if (!TokenManager.instance) {
      TokenManager.instance = new TokenManager();
    }
    return TokenManager.instance;
  }

  async getToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.token!;
    }
    return this.refreshToken();
  }

  async createOctokit(): Promise<Octokits> {
    const token = await this.getToken();
    return this.createOctokitWithRetry(token);
  }

  private isTokenValid(): boolean {
    if (!this.token || !this.tokenExpiry) {
      return false;
    }
    // Check if token will expire in the next 5 minutes
    const expiryBuffer = 5 * 60 * 1000;
    return new Date().getTime() < this.tokenExpiry.getTime() - expiryBuffer;
  }

  private async refreshToken(): Promise<string> {
    // Prevent concurrent refresh attempts
    if (this.refreshPromise) {
      console.log("Token refresh already in progress, waiting...");
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh();
    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<string> {
    console.log("Refreshing GitHub token...");

    try {
      // Check if GitHub token was provided as override
      const providedToken = process.env.OVERRIDE_GITHUB_TOKEN;

      if (providedToken) {
        console.log("Using provided GITHUB_TOKEN (no expiry)");
        this.token = providedToken;
        this.tokenExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year for override tokens
        return providedToken;
      }

      // Get OIDC token
      const oidcToken = await this.retryWithBackoff(() => this.getOidcToken());
      console.log("OIDC token obtained");

      // Exchange for app token
      const appToken = await this.retryWithBackoff(() =>
        this.exchangeForAppToken(oidcToken),
      );
      console.log("App token obtained");

      // Update stored token and expiry
      this.token = appToken;
      this.tokenExpiry = new Date(Date.now() + this.TOKEN_LIFETIME_MS);

      return appToken;
    } catch (error) {
      console.error("Failed to refresh token:", error);
      throw new Error(`Token refresh failed: ${error}`);
    }
  }

  private async getOidcToken(): Promise<string> {
    try {
      const oidcToken = await core.getIDToken("claude-code-github-action");
      return oidcToken;
    } catch (error) {
      console.error("Failed to get OIDC token:", error);
      throw new Error(
        "Could not fetch an OIDC token. Did you remember to add `id-token: write` to your workflow permissions?",
      );
    }
  }

  private async exchangeForAppToken(oidcToken: string): Promise<string> {
    const response = await fetch(
      "https://api.anthropic.com/api/github/github-app-token-exchange",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oidcToken}`,
        },
      },
    );

    if (!response.ok) {
      const responseJson = (await response.json()) as {
        error?: {
          message?: string;
        };
      };
      console.error(
        `App token exchange failed: ${response.status} ${response.statusText} - ${responseJson?.error?.message ?? "Unknown error"}`,
      );
      throw new Error(`${responseJson?.error?.message ?? "Unknown error"}`);
    }

    const appTokenData = (await response.json()) as {
      token?: string;
      app_token?: string;
    };
    const appToken = appTokenData.token || appTokenData.app_token;

    if (!appToken) {
      throw new Error("App token not found in response");
    }

    return appToken;
  }

  private createOctokitWithRetry(token: string): Octokits {
    const self = this;

    // Create base Octokit instance
    const baseOctokit = new Octokit({
      auth: token,
      request: {
        hook: async (request, options) => {
          try {
            return await request(options);
          } catch (error: any) {
            // Check for authentication errors
            if (error.status === 401 || error.status === 403) {
              console.log(
                `Authentication error (${error.status}), refreshing token...`,
              );

              // Refresh the token
              const newToken = await self.refreshToken();

              // Retry with new token
              options.headers.authorization = `token ${newToken}`;
              return await request(options);
            }
            throw error;
          }
        },
      },
    });

    // Create GraphQL client with retry logic
    const graphqlWithRetry = graphql.defaults({
      baseUrl: GITHUB_API_URL,
      headers: {
        authorization: `token ${token}`,
      },
      request: {
        hook: async (request, options) => {
          try {
            return await request(options);
          } catch (error: any) {
            // Check for authentication errors
            if (error.status === 401 || error.status === 403) {
              console.log(
                `GraphQL authentication error (${error.status}), refreshing token...`,
              );

              // Refresh the token
              const newToken = await self.refreshToken();

              // Retry with new token
              options.headers.authorization = `token ${newToken}`;
              return await request(options);
            }
            throw error;
          }
        },
      },
    });

    return {
      rest: baseOctokit,
      graphql: graphqlWithRetry,
    };
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {},
  ): Promise<T> {
    const {
      maxAttempts = 3,
      initialDelayMs = 5000,
      maxDelayMs = 20000,
      backoffFactor = 2,
    } = options;

    let delayMs = initialDelayMs;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Attempt ${attempt} of ${maxAttempts}...`);
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`Attempt ${attempt} failed:`, lastError.message);

        if (attempt < maxAttempts) {
          console.log(`Retrying in ${delayMs / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
        }
      }
    }

    console.error(`Operation failed after ${maxAttempts} attempts`);
    throw lastError;
  }

  // For testing purposes
  resetInstance(): void {
    this.token = null;
    this.tokenExpiry = null;
    this.refreshPromise = null;
  }
}

// Export a singleton instance
export const tokenManager = TokenManager.getInstance();
