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

const randomBytesAsync = promisify(randomBytes);

export async function watch(
  project: Pick<Project, "groupId" | "fileId" | "folderId">
): Promise<void> {
  if (!global.process.env["FILE_CHANGE_BASE_URL"]) return;
  const baseUrl = global.process.env["FILE_CHANGE_BASE_URL"];

  const folderChannelId = randomUUID();
  const drive = await driveClient();
  console.log(
    `Creating channel for group ${project.groupId} with id:`,
    folderChannelId
  );
  const tokenBuffer = await randomBytesAsync(64);
  const token = tokenBuffer.toString("base64url");
  const fullToken = "token=" + token;
  const response = await drive.files.watch({
    fileId: project.folderId,
    requestBody: {
      id: folderChannelId,
      type: "web_hook",
      address: `${baseUrl}/projects/${project.groupId}/notify`,
      expiration: "" + (Date.now() + 86_400_000),
      token: fullToken,
    },
  });

  const dynamoDb = dynamoDbClient();
  await dynamoDb.update({
    Key: {
      groupId: project.groupId,
      fileId: project.fileId,
    },
    UpdateExpression: "SET folderChannelId=:f, folderChannelToken=:t",
    ExpressionAttributeValues: {
      ":f": folderChannelId,
      ":t": fullToken,
    },
  });

  console.log("expires:", response.data.expiration);
}

export async function notify(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const processImagesFunctionName = process.env["PROCESS_IMAGES_FUNCTION_NAME"];
  if (!processImagesFunctionName) {
    console.error("Missing PROCESS_IMAGES_FUNCTION_NAME");
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

  console.info("Checking headers");
  if (event.headers["x-goog-channel-id"] !== project?.folderChannelId) {
    console.info(
      "Ignoring because channel id doesn't match:",
      event.headers["x-goog-channel-id"],
      project?.folderChannelId
    );
    return ok("");
  }
  if (event.headers["x-goog-resource-state"] === "sync") {
    console.info("Ignoring because this is a sync call");
    return ok("");
  }
  if (event.headers["x-goog-channel-token"] !== project?.folderChannelToken) {
    console.info(
      "Ignoring because the token doesn't match",
      event.headers["x-goog-channel-token"],
      project?.folderChannelToken
    );
    return ok("");
  }
  console.info("Everything matches, invoking processImages");

  const lambda = new LambdaClient({});
  const payload = { groupId: groupId };
  await lambda.send(
    new InvokeCommand({
      FunctionName: processImagesFunctionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
  console.info("Invoked", processImagesFunctionName, payload);

  return ok(event.body);
}
