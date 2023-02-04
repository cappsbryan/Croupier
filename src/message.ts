import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { DynamoDB } from "aws-sdk";
import { CredentialBody } from "google-auth-library";
import { drive_v3, google } from "googleapis";
import { Convert, GroupMeCallback } from "./dtos/GroupMeCallback";
import { badRequest, internalServerError, notFound, ok } from "./responses";

const awsSessionToken = process.env.AWS_SESSION_TOKEN as string;

export async function post(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!event.body) throw badRequest();
  if (!process.env.DYNAMODB_PROJECT_TABLE)
    return internalServerError("Failed to connect to database");

  let groupMeCallback: GroupMeCallback;
  try {
    groupMeCallback = Convert.toGroupMeCallback(event.body);
  } catch (e) {
    return badRequest(e.message);
  }

  const dynamoDb = new DynamoDB.DocumentClient();
  const attributes = await dynamoDb
    .get({
      TableName: process.env.DYNAMODB_PROJECT_TABLE,
      Key: {
        groupme_group_id: groupMeCallback.group_id,
        file_id: "!",
      },
    })
    .promise();
  const project = attributes.Item;
  if (!project) return notFound();

  return ok({
    group_id: project.groupme_group_id,
    fileCount: await fileCount(project.drive_folder_id),
  });
}

async function fileCount(folderId: string): Promise<number> {
  const drive = await driveClient();
  const opts = {
    q: `'${folderId}' in parents`,
    fields: "nextPageToken, files(id)",
    pageSize: 1000,
  };

  let res = await drive.files.list(opts);
  let count = res.data.files?.length ?? 0;
  while (res.data.nextPageToken) {
    res = await drive.files.list({
      ...opts,
      pageToken: res.data.nextPageToken,
    });
    count += res.data.files?.length ?? 0;
  }

  return count;
}

async function driveClient(): Promise<drive_v3.Drive> {
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

  return google.drive({
    version: "v3",
    auth: new google.auth.GoogleAuth({
      credentials: credentialsJson,
      scopes: ["https://www.googleapis.com/auth/drive"],
    }),
  });
}
