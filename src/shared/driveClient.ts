import { auth, drive } from "@googleapis/drive";
import type { drive_v3 } from "@googleapis/drive";
import { googleServiceAccountKey } from "./secrets";

let cachedDriveClient: Promise<drive_v3.Drive> | undefined;

export async function driveClient(): Promise<drive_v3.Drive> {
  if (cachedDriveClient) return cachedDriveClient;

  cachedDriveClient = googleAuth().then((auth) => {
    return drive({
      version: "v3",
      auth: auth,
    });
  });

  return cachedDriveClient;
}

async function googleAuth() {
  const keyString = await googleServiceAccountKey();
  const credentialsJson = JSON.parse(keyString);

  return new auth.GoogleAuth({
    credentials: credentialsJson,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}
