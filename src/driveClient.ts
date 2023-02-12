import { drive_v3, google } from "googleapis";
import { GoogleAuth } from "googleapis-common";

const awsSessionToken = process.env.AWS_SESSION_TOKEN as string;
let cachedDriveClient: drive_v3.Drive | undefined;

export async function driveClient(): Promise<drive_v3.Drive> {
  if (cachedDriveClient) return cachedDriveClient;

  console.time("drive auth");
  const auth = process.env.IS_OFFLINE
    ? offlineGoogleAuth()
    : await googleAuth();
  console.timeEnd("drive auth");

  cachedDriveClient = google.drive({
    version: "v3",
    auth: auth,
  });
  return cachedDriveClient;
}

async function googleAuth(): Promise<GoogleAuth> {
  const parameterUrl =
    "http://localhost:2773/systemsmanager/parameters/get?name=croupier-google-service-account-key&withDecryption=true";
  const parameterRequest = new Request(parameterUrl);
  parameterRequest.headers.set(
    "X-Aws-Parameters-Secrets-Token",
    awsSessionToken
  );
  const response = await fetch(parameterRequest);
  const responseJson = await response.json();
  const credentialsJson = JSON.parse(responseJson.Parameter.Value);

  return new google.auth.GoogleAuth({
    credentials: credentialsJson,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

function offlineGoogleAuth(): GoogleAuth {
  // Note: __dirname resolves to the .build/src folder
  return new google.auth.GoogleAuth({
    keyFile: __dirname + "/../../offline_config/google_service_account.json",
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}
