import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { DocumentClient } from "aws-sdk/clients/dynamodb";
import { drive_v3 } from "googleapis";

import { Readable } from "stream";
import { ReadableStream } from "stream/web";

import { driveClient } from "./driveClient";
import { dynamoDbClient, ProjectTableClient } from "./dynamoDbClient";
import { Image } from "./models/Image";
import { Project } from "./models/Project";
import { badRequest, internalServerError, notFound, ok } from "./responses";
import { groupmeAccessToken } from "./secrets";

type ValidDriveImage = {
  id: string;
  mimeType: string;
  name: string;
};

function isValidDriveImage(
  file: drive_v3.Schema$File
): file is ValidDriveImage {
  return !!file.id && !!file.mimeType && !!file.name;
}

export async function processImages(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const claimedSub = event.requestContext.authorizer.jwt.claims.sub;
  const groupId = event.pathParameters?.groupId;

  if (!groupId) return badRequest("Missing id in path");
  if (!claimedSub) return badRequest("Not authorized");

  const dbResult = await projectAndImagesWithUri(groupId);

  if (!dbResult || claimedSub != dbResult.project.subject) return notFound();

  const [driveFiles, imagesWithUri] = await Promise.all([
    driveQuery(driveClient(), dbResult.project.folderId),
    dbResult.imagesWithUri,
  ]);
  if (!driveFiles)
    return internalServerError("Failed to retrieve files from Google Drive");
  if (!imagesWithUri)
    return internalServerError("Failed to retrieve image data from db");

  const doneImageIds = new Set(imagesWithUri.map((image) => image.fileId));
  const newImageFiles = driveFiles.filter((file) => !doneImageIds.has(file.id));

  const dynamoDb = dynamoDbClient();
  const chunkSize = 25; // max number of requests in a BatchWriteItem
  for (let i = 0; i < 1; i += chunkSize) {
    const chunk = newImageFiles.slice(i, i + chunkSize);
    let imageDataStreams: ReadableStream[] = [];
    for (const file of chunk) {
      imageDataStreams.push(await downloadNewImage(file.id));
    }
    const imageUrls = await Promise.all(
      imageDataStreams.map((stream, i) =>
        uploadNewImage(chunk[i].id, stream, chunk[i].mimeType)
      )
    );
    await dynamoDb.batchWrite({
      RequestItems: chunk.map((file, index) => ({
        PutRequest: {
          Item: {
            groupId: groupId,
            fileId: file.id,
            fname: file.name.toLowerCase(),
            uri: imageUrls[index],
          },
        },
      })),
    });
  }

  return ok("Processed images");
}

async function downloadNewImage(fileId: string): Promise<ReadableStream> {
  const drive = await driveClient();

  console.log(`Downloading file ${fileId}...`);
  const driveResponse = await drive.files.get(
    {
      fileId: fileId,
      alt: "media",
    },
    { responseType: "stream" }
  );
  return Readable.toWeb(driveResponse.data);
}

async function uploadNewImage(
  fileId: string,
  stream: ReadableStream,
  mimeType: string
): Promise<string> {
  console.log(`Uploading file ${fileId}...`);
  const uploadResponse = await fetch("https://image.groupme.com/pictures", {
    body: stream as any,
    method: "post",
    headers: {
      "X-Access-Token": await groupmeAccessToken(),
      "Content-Type": mimeType,
    },
  });
  const uploadResponseBody = await uploadResponse.json();
  const imageUrl: string = uploadResponseBody?.payload?.url;
  return imageUrl;
}

async function driveQuery(
  clientPromise: Promise<drive_v3.Drive> | drive_v3.Drive,
  folderId: string,
  pageToken?: string
): Promise<ValidDriveImage[] | undefined> {
  const client = await clientPromise;
  const listResponse = await client.files.list({
    q: `'${folderId}' in parents and mimeType contains 'image/'`,
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

const queryProjection = ["groupId", "fileId", "folderId", "subject"] as const;
type QueryProjectResult = Pick<Project, typeof queryProjection[number]>;
type QueryImagesResult = Pick<
  Image,
  Extract<typeof queryProjection[number], keyof Image>
>[];
type QueryResult = {
  project: QueryProjectResult;
  imagesWithUri: Promise<QueryImagesResult | undefined>;
};

async function projectAndImagesWithUri(
  groupId: string
): Promise<QueryResult | undefined> {
  const dynamoDb = dynamoDbClient();
  const params: ProjectTableClient.QueryInput = {
    KeyConditionExpression: "groupId = :g",
    ExpressionAttributeValues: { ":g": groupId },
    FilterExpression: "attribute_exists(uri) OR attribute_exists(folderId)",
    ProjectionExpression: queryProjection.join(", "),
  };
  const attributes = await dynamoDb.query(params);
  const items = attributes.Items as QueryImagesResult | undefined;
  if (!items || items.length === 0) return;

  return {
    project: items[0] as QueryProjectResult,
    imagesWithUri: continueDbQuery(
      items.slice(1),
      params,
      attributes.LastEvaluatedKey
    ),
  };
}

async function continueDbQuery(
  firstImages: QueryImagesResult,
  params: ProjectTableClient.QueryInput,
  startKey: DocumentClient.Key | undefined
): Promise<QueryImagesResult | undefined> {
  const dynamoDb = dynamoDbClient();
  const attributes = await dynamoDb.fullQuery({
    ...params,
    ExclusiveStartKey: startKey,
  });
  const items = attributes.Items as QueryImagesResult | undefined;
  if (!items) return;

  return firstImages.concat(items);
}
