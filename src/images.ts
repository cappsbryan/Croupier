import {
  AddPermissionCommand,
  GetPolicyCommand,
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
} from "@aws-sdk/client-eventbridge";
import type { drive_v3 } from "@googleapis/drive";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { driveClient } from "./driveClient";
import { dynamoDbClient } from "./dynamoDbClient";
import type { Image } from "./models/Image";
import type { Project } from "./models/Project";
import { badRequest, internalServerError, notFound, ok } from "./responses";

export async function checkProcess(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims["sub"];
  const groupId = event.pathParameters?.["groupId"];
  if (!groupId) return badRequest("Missing id in path");
  if (!claimedSub) return badRequest("Not authorized");

  const dbResult = await projectAndImages(groupId);
  if (!dbResult || claimedSub !== dbResult.project.subject) return notFound();

  const [driveFiles, dbImages] = await Promise.all([
    driveQuery(driveClient(), dbResult.project.folderId),
    dbResult.images,
  ]);
  if (!driveFiles)
    return internalServerError("Failed to retrieve files from Google Drive");
  if (!dbImages)
    return internalServerError("Failed to retrieve image data from db");

  return ok({
    processed: dbImages.length,
    total: driveFiles.length,
  });
}

export async function processHTTP(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims["sub"];
  const groupId = event.pathParameters?.["groupId"];

  const dynamoDb = dynamoDbClient();
  const attributes = await dynamoDb.get({
    Key: {
      groupId: groupId,
      fileId: "!",
    },
  });

  const project = attributes.Item;
  if (!project || project["subject"] != claimedSub) return notFound();

  return process({ groupId });
}

export async function process(event: {
  groupId: string | undefined;
}): Promise<APIGatewayProxyStructuredResultV2> {
  if (!event.groupId) return badRequest("Missing id in path");
  const groupId = event.groupId;

  const dbResult = await projectAndImages(groupId);
  if (!dbResult) {
    return notFound();
  }
  await setupRecurringFolderWatch(dbResult.project);

  const [driveFiles, dbImages] = await Promise.all([
    driveQuery(driveClient(), dbResult.project.folderId),
    dbResult.images,
  ]);
  if (!driveFiles)
    return internalServerError("Failed to retrieve files from Google Drive");
  if (!dbImages)
    return internalServerError("Failed to retrieve image data from db");

  const dbImagesMap: Record<string, QueryImageResult | undefined> =
    Object.fromEntries(dbImages.map((image) => [image.fileId, image]));
  const driveFilesMap: Record<string, ValidDriveImage | undefined> =
    Object.fromEntries(driveFiles.map((file) => [file.id, file]));
  const extraImages = dbImages.filter((image) => !driveFilesMap[image.fileId]);

  const dynamoDb = dynamoDbClient();
  await dynamoDb.batchWrite({
    RequestItems: [
      ...driveFiles.map((file) => {
        const dbImage = dbImagesMap[file.id];
        const image: Image = {
          groupId: groupId,
          fileId: file.id,
          version: file.version,
          fname: file.name.toLowerCase(),
          uri: file.version === dbImage?.version ? dbImage.uri : undefined,
          posted:
            file.version === dbImage?.version ? dbImage.posted : undefined,
        };
        return {
          PutRequest: {
            Item: image,
          },
        };
      }),
      ...extraImages.map((image) => ({
        DeleteRequest: {
          Key: {
            groupId: groupId,
            fileId: image.fileId,
          },
        },
      })),
    ],
  });

  return ok({ message: `Processed ${driveFiles.length} images` });
}

const driveFilesFields = ["id", "mimeType", "name", "version"] as const;
type ValidDriveImage = {
  [key in keyof drive_v3.Schema$File &
    typeof driveFilesFields[number]]: NonNullable<drive_v3.Schema$File[key]>;
};

function isValidDriveImage(
  file: drive_v3.Schema$File
): file is ValidDriveImage {
  return !!file.id && !!file.mimeType && !!file.name && !!file.version;
}

async function driveQuery(
  clientPromise: Promise<drive_v3.Drive> | drive_v3.Drive,
  folderId: string,
  pageToken?: string
): Promise<ValidDriveImage[] | undefined> {
  const client = await clientPromise;
  const listResponse = await client.files.list({
    q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
    fields: `nextPageToken,files(${driveFilesFields.join()})`,
    pageSize: 1000,
    pageToken: pageToken,
  });
  const unverifiedFiles = listResponse.data.files;
  if (!unverifiedFiles) return;
  const files = unverifiedFiles.filter(isValidDriveImage);

  if (unverifiedFiles.length !== files.length) {
    const failed = unverifiedFiles.length - files.length;
    console.warn(`Unable to verify ${failed} drive files`);
  }

  // base case, return without recursive call if this is the last page
  if (!listResponse.data.nextPageToken) return files;

  // recursive call because this isn't the last page
  const additionalFiles = await driveQuery(
    client,
    folderId,
    listResponse.data.nextPageToken
  );
  if (!additionalFiles) return;

  return files.concat(additionalFiles);
}

const queryProjection = [
  "groupId",
  "fileId",
  "version",
  "folderId",
  "subject",
  "uri",
  "posted",
] as const;
type QueryProjectResult = Pick<
  Project,
  Extract<typeof queryProjection[number], keyof Project>
>;
type QueryImageResult = Pick<
  Image,
  Extract<typeof queryProjection[number], keyof Image>
>;
type QueryResult = {
  project: QueryProjectResult;
  images: QueryImageResult[];
};

async function projectAndImages(
  groupId: string
): Promise<QueryResult | undefined> {
  const dynamoDb = dynamoDbClient();
  const attributes = await dynamoDb.fullQuery({
    KeyConditionExpression: "groupId = :g",
    ExpressionAttributeValues: { ":g": groupId },
    ProjectionExpression: queryProjection.join(", "),
  });
  const items = attributes.Items as
    | (QueryProjectResult | QueryImageResult)[]
    | undefined;
  if (!items || items.length === 0) return;

  const project = items[0];
  const images = items.slice(1);

  return {
    project: project as QueryProjectResult,
    images: images as QueryImageResult[],
  };
}

async function setupRecurringFolderWatch(project: QueryProjectResult) {
  const fileChangedWatcherArn = global.process.env["FILE_CHANGED_WATCHER_ARN"];
  if (!fileChangedWatcherArn) {
    console.error("FILE_CHANGED_WATCHER_ARN not set");
    return;
  }
  const fileChangedWatcherName =
    global.process.env["FILE_CHANGED_WATCHER_NAME"];
  if (!fileChangedWatcherName) {
    console.error("FILE_CHANGED_WATCHER_NAME not set");
    return;
  }
  const fileWatcherEventRuleNamePrefix =
    global.process.env["FILE_WATCHER_EVENT_RULE_NAME_PREFIX"];
  if (!fileWatcherEventRuleNamePrefix) {
    console.error("FILE_WATCHER_EVENT_RULE_NAME_PREFIX not set");
    return;
  }

  const ruleName = fileWatcherEventRuleNamePrefix + project.groupId;
  const statementId = ruleName + "-permission";
  const eventBridge = new EventBridgeClient({});
  const rule = await eventBridge.send(
    new PutRuleCommand({
      Name: ruleName,
      ScheduleExpression: `rate(23 hours)`,
    })
  );
  await eventBridge.send(
    new PutTargetsCommand({
      Rule: ruleName,
      Targets: [
        {
          Id: "fileChangedWatcher",
          Arn: fileChangedWatcherArn,
          Input: JSON.stringify(project),
        },
      ],
    })
  );

  const lambda = new LambdaClient({});
  let statements: { Sid: string }[];
  try {
    const policyResponse = await lambda.send(
      new GetPolicyCommand({
        FunctionName: fileChangedWatcherName,
      })
    );
    const policy: { Statement: [{ Sid: string }] } = policyResponse.Policy
      ? JSON.parse(policyResponse.Policy)
      : undefined;
    statements = policy.Statement;
  } catch {
    statements = [];
  }

  if (!statements.find((statement) => statement.Sid === statementId)) {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: fileChangedWatcherName,
        StatementId: statementId,
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
        SourceArn: rule.RuleArn,
      })
    );
  }

  await lambda.send(
    new InvokeCommand({
      FunctionName: fileChangedWatcherName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(project)),
    })
  );
}
