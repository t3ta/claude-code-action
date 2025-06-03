import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { GITHUB_API_URL } from "./config";

export type Octokits = {
  rest: Octokit;
  graphql: typeof graphql;
};

export function createOctokit(token: string): Octokits {
  return {
    rest: new Octokit({ auth: token }),
    graphql: graphql.defaults({
      baseUrl: GITHUB_API_URL,
      headers: {
        authorization: `token ${token}`,
      },
    }),
  };
}
