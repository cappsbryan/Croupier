import { drive_v3, google } from "googleapis";
import { GoogleAuth } from "googleapis-common";
import { googleServiceAccountKey } from "./secrets";

let cachedDriveClient: Promise<drive_v3.Drive> | undefined;

export async function driveClient(): Promise<drive_v3.Drive> {
  if (cachedDriveClient) return cachedDriveClient;

  cachedDriveClient = googleAuth().then((auth) => {
    return google.drive({
      version: "v3",
      auth: auth,
    });
  });

  return cachedDriveClient;
}

async function googleAuth(): Promise<GoogleAuth> {
  const keyString = await googleServiceAccountKey();
  const credentialsJson = JSON.parse(keyString);

  return new google.auth.GoogleAuth({
    credentials: credentialsJson,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}
