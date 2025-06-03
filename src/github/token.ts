#!/usr/bin/env bun

import * as core from "@actions/core";
import { tokenManager } from "./token-manager";

export async function setupGitHubToken(): Promise<string> {
  try {
    // Get token through TokenManager (handles refresh automatically)
    const token = await tokenManager.getToken();

    console.log("GitHub token successfully obtained");
    core.setOutput("GITHUB_TOKEN", token);
    return token;
  } catch (error) {
    core.setFailed(
      `Failed to setup GitHub token: ${error}.\n\nIf you instead wish to use this action with a custom GitHub token or custom GitHub app, provide a \`github_token\` in the \`uses\` section of the app in your workflow yml file.`,
    );
    process.exit(1);
  }
}
