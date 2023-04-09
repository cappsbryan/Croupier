import { randomBytes, randomUUID } from "crypto";
import { promisify } from "util";

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { driveClient } from "../shared/driveClient";
import { internalServerError, ok } from "../shared/responses";
import type { Project } from "../models/Project";
import { dynamoDbClient } from "../shared/dynamoDbClient";
import type { Image } from "../models/Image";
import { driveFilesFields, isValidDriveImage } from "../shared/images";

const randomBytesAsync = promisify(randomBytes);

export async function watch(
  project: Pick<Project, "groupId" | "fileId" | "folderId">
): Promise<void> {
  if (!global.process.env["FILE_CHANGE_BASE_URL"]) return;
  const baseUrl = global.process.env["FILE_CHANGE_BASE_URL"];

  const folderChannelId = randomUUID();
  const drive = await driveClient();

  const pageTokenResponse = await drive.changes.getStartPageToken({
    fields: "startPageToken",
  });
  const pageToken = pageTokenResponse.data.startPageToken;
  if (!pageToken) {
    console.warn("Failed to get pageToken:", pageTokenResponse.data);
    return;
  }

  console.log(
    `Creating channel for group ${project.groupId} with id:`,
    folderChannelId
  );
  const tokenBuffer = await randomBytesAsync(64);
  const token = tokenBuffer.toString("base64url");
  const fullToken = "token=" + token;
  const response = await drive.changes.watch({
    pageToken: pageToken,
    requestBody: {
      id: folderChannelId,
      type: "web_hook",
      address: `${baseUrl}/projects/${project.groupId}/notify`,
      expiration: "" + (Date.now() + 604_800_000), // a week from now (168 hours)
      token: fullToken,
    },
  });

  const dynamoDb = dynamoDbClient();
  await dynamoDb.update({
    Key: {
      groupId: project.groupId,
      fileId: project.fileId,
    },
    UpdateExpression:
      "SET folderChannelId=:f, folderChannelToken=:t, nextStartPageToken=:pt",
    ExpressionAttributeValues: {
      ":f": folderChannelId,
      ":t": fullToken,
      ":pt": pageToken,
    },
  });

  console.log("expires:", response.data.expiration);
}

export async function notify(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const processChangeFunctionName =
    global.process.env["PROCESS_CHANGE_FUNCTION_NAME"];
  if (!processChangeFunctionName) {
    console.error("Missing PROCESS_CHANGE_FUNCTION_NAME");
    return internalServerError();
  }
  const groupId = event.pathParameters?.["groupId"];
  if (!groupId) {
    console.error("Missing groupId from path");
    return internalServerError();
  }

  const dynamoDb = dynamoDbClient();
  const projectResponse = await dynamoDb.get({
    Key: {
      groupId: groupId,
      fileId: "!",
    },
  });
  const project = projectResponse.Item as Project | undefined;
  if (!project) {
    console.warn("Failed to retrieve project");
    return ok("");
  }

  if (event.headers["x-goog-channel-id"] !== project.folderChannelId) {
    console.info(
      "Ignoring because channel id doesn't match:",
      event.headers["x-goog-channel-id"],
      "!=",
      project.folderChannelId
    );
    console.info("Expires:", event.headers["x-goog-channel-expiration"]);
    return ok("");
  }
  if (event.headers["x-goog-resource-state"] === "sync") {
    console.info(
      "Ignoring because this is a sync call. Expiration:",
      event.headers["x-goog-channel-expiration"]
    );
    return ok("");
  }
  if (event.headers["x-goog-channel-token"] !== project.folderChannelToken) {
    console.info(
      "Ignoring because the token doesn't match",
      event.headers["x-goog-channel-token"],
      project.folderChannelToken
    );
    return ok("");
  }
  console.info(
    "Headers match, listing changes at page",
    project.nextStartPageToken
  );

  const drive = await driveClient();
  const listChangesResponse = await drive.changes.list({
    pageToken: project.nextStartPageToken,
  });

  const lambda = new LambdaClient({});
  console.info("Changes:", listChangesResponse.data);
  if (!listChangesResponse.data.changes) {
    console.warn("No changes");
    return ok("");
  }

  await Promise.all(
    listChangesResponse.data.changes.map(async (change, index) => {
      console.info("Change", index, ":", change);
      if (!change.fileId) {
        console.warn("No fileId in change");
        return;
      }
      const payload: Parameters<typeof process>[0] = {
        groupId: groupId,
        fileId: change.fileId,
        removed: change.removed ?? false,
      };
      await lambda.send(
        new InvokeCommand({
          FunctionName: processChangeFunctionName,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify(payload)),
        })
      );
      console.info("Invoked", processChangeFunctionName, payload);
    })
  );
  await dynamoDb.update({
    Key: {
      groupId: groupId,
      fileId: "!",
    },
    UpdateExpression: "SET nextStartPageToken = :t",
    ExpressionAttributeValues: {
      ":t": listChangesResponse.data.newStartPageToken,
    },
  });

  return ok(event.body);
}

export async function process(event: {
  groupId: string;
  fileId: string;
  removed: boolean;
}): Promise<void> {
  if (event.removed) {
    console.info("Deleting removed file", event.fileId);
    deleteTrashed(event);
  }

  const drive = await driveClient();
  const dynamoDb = dynamoDbClient();

  const [dbImageResponse, dbProjectResponse] = await Promise.all([
    dynamoDb.get({ Key: { groupId: event.groupId, fileId: event.fileId } }),
    dynamoDb.get({ Key: { groupId: event.groupId, fileId: "!" } }),
  ]);
  const dbImage = dbImageResponse.Item as Image | undefined;
  const dbProject = dbProjectResponse.Item as Project | undefined;

  if (!dbProject) {
    console.warn("Failed to retrieve project info for group", event.groupId);
    return;
  }

  const fileInfoResponse = await drive.files.get({
    fileId: event.fileId,
    fields: [...driveFilesFields, "parents", "trashed"].join(),
  });
  const fileInfo = fileInfoResponse.data;

  if (fileInfo.trashed) {
    console.info("Deleting trashed file", event.fileId);
    await deleteTrashed(event);
    return;
  }
  if (!fileInfo.parents || !fileInfo.parents.includes(dbProject.folderId)) {
    console.info("Deleting moved file", event.fileId);
    await deleteTrashed(event);
    return;
  }

  if (!isValidDriveImage(fileInfo)) {
    console.warn("Not a valid drive image:", fileInfo);
    return;
  }

  const image: Image = {
    groupId: event.groupId,
    fileId: event.fileId,
    version: fileInfo.version,
    fname: fileInfo.name.toLowerCase(),
    uri: fileInfo.version === dbImage?.version ? dbImage.uri : undefined,
    posted: fileInfo.version === dbImage?.version ? dbImage.posted : undefined,
  };
  console.info("Updating changed file", image);
  await dynamoDb.put({ Item: image });
}

async function deleteTrashed(event: {
  groupId: string;
  fileId: string;
}): Promise<void> {
  const dynamoDb = dynamoDbClient();
  await dynamoDb.delete({
    Key: { groupId: event.groupId, fileId: event.fileId },
  });
}
