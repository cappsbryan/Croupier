import { readFile } from "fs/promises";

const awsSessionToken = process.env["AWS_SESSION_TOKEN"] as string;

export function googleServiceAccountKey(): Promise<string> {
  return getParameter("croupier-google-service-account-key");
}

export function groupmeAccessToken(): Promise<string> {
  return getParameter("croupier-groupme-access-token");
}

async function getParameter(name: string): Promise<string> {
  if (process.env["IS_OFFLINE"]) {
    // Note: __dirname resolves to the .esbuild/.build/src/shared folder
    return await readFile(
      __dirname + "/../../../../offline_secrets/" + name,
      "utf8"
    );
  }

  const baseUrl =
    "http://localhost:2773/systemsmanager/parameters/get?withDecryption=true";
  const paramUrl = baseUrl + "&name=" + name;
  const response = await fetch(paramUrl, {
    headers: { "X-Aws-Parameters-Secrets-Token": awsSessionToken },
  });
  const json = (await response.json()) as { Parameter: { Value: string } };
  return json.Parameter.Value;
}
